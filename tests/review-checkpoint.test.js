const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ReviewCheckpoint, stableTaskId } = require('../scripts/review-checkpoint');

test('checkpoint commits validated chunks atomically and resumes completed chunks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-checkpoint-test-'));
  const checkpointPath = path.join(dir, 'review.json');
  const taskId = stableTaskId({ repo: 'test/repo', pr: 7, head: 'abc' });
  const first = new ReviewCheckpoint({ taskId, checkpointPath, chunkCount: 3, headSha: 'abc', reviewTarget: 'PR:7' }).load();
  assert.equal(first.isFullyComplete(), false);
  first.commit(0, { findings: [{ path: 'a.ts', line: 1, side: 'RIGHT', severity: 'P1', comment: 'Bug' }], providers: ['gemini:model:k1'] });
  first.commit(1, { findings: [], providers: ['gemini:model:k2'] });

  const resumed = new ReviewCheckpoint({ taskId, checkpointPath, chunkCount: 3, headSha: 'abc', reviewTarget: 'PR:7' }).load();
  assert.equal(resumed.isComplete(0), true);
  assert.equal(resumed.isComplete(1), true);
  assert.equal(resumed.isComplete(2), false);
  assert.deepEqual(resumed.completed(0).findings, [{ path: 'a.ts', line: 1, side: 'RIGHT', severity: 'P1', comment: 'Bug' }]);
  assert.equal(resumed.completedEntries().length, 2);

  resumed.commit(2, { findings: [], providers: ['gemini:model:k3'] });
  assert.equal(resumed.isFullyComplete(), true);
});

test('checkpoint refuses a different review identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-checkpoint-test-'));
  const checkpointPath = path.join(dir, 'review.json');
  const first = new ReviewCheckpoint({ taskId: 'task-a', checkpointPath, chunkCount: 1, headSha: 'abc', reviewTarget: 'PR:1' }).load();
  first.commit(0, { findings: [], providers: [] });
  const restarted = new ReviewCheckpoint({ taskId: 'task-b', checkpointPath, chunkCount: 1, headSha: 'abc', reviewTarget: 'PR:1' }).load();
  assert.equal(restarted.isFullyComplete(), false);
  assert.equal(restarted.invalidCheckpointQuarantined, true);
  assert.equal(fs.existsSync(checkpointPath), false);
});

const { postInlineComment, findingMarker } = require('../scripts/call-review-gateway');

test('inline finding publication is idempotent across reruns', async () => {
  const originalFetch = global.fetch;
  const finding = { path: 'src/app.js', line: 42, side: 'RIGHT', severity: 'P1', comment: 'Concrete production defect.' };
  const headSha = 'head-sha';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') throw new Error('POST must not occur for an already-published finding.');
    return {
      ok: true,
      async json() {
        return [{
          commit_id: headSha,
          user: { login: 'github-actions[bot]', id: 41898282 },
          body: findingMarker(headSha, finding) + '\n**[P1]** Concrete production defect.',
        }];
      },
      async text() { return ''; },
    };
  };
  try {
    const posted = await postInlineComment('owner', 'repo', 7, headSha, finding);
    assert.equal(posted, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, undefined);
  } finally {
    global.fetch = originalFetch;
  }
});

test('same chunk count but different plan hash rejects checkpoint resume', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-plan-test-'));
  const checkpointPath = path.join(dir, 'state.json');
  new ReviewCheckpoint({ taskId: 'plan-a', checkpointPath, chunkCount: 2, planHash: 'a'.repeat(64) }).commit(0, { findings: [], providers: [] });
  const differentPlan = new ReviewCheckpoint({ taskId: 'plan-a', checkpointPath, chunkCount: 2, planHash: 'b'.repeat(64) }).load();
  assert.equal(differentPlan.isComplete(0), false);
  assert.equal(differentPlan.invalidCheckpointQuarantined, true);
});

test('malformed and out-of-range completed chunks are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-invalid-test-'));
  const checkpointPath = path.join(dir, 'state.json');
  const cp = new ReviewCheckpoint({ taskId: 'invalid', checkpointPath, chunkCount: 1 });
  cp.commit(0, { findings: [], providers: [] });
  const state = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  state.completedChunks['5'] = { chunkIndex: 5, findings: [], providers: [], committedAt: new Date().toISOString() };
  fs.writeFileSync(checkpointPath, JSON.stringify(state));
  const recovered = new ReviewCheckpoint({ taskId: 'invalid', checkpointPath, chunkCount: 1 }).load();
  assert.equal(recovered.isFullyComplete(), false);
  assert.equal(recovered.invalidCheckpointQuarantined, true);
});

test('failed atomic rename does not mark in-memory chunk complete', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-rename-fail-'));
  const cp = new ReviewCheckpoint({ taskId: 'rename', checkpointPath: path.join(dir, 'state.json'), chunkCount: 1 });
  const rename = fs.renameSync;
  fs.renameSync = () => { throw new Error('injected rename failure'); };
  try {
    assert.throws(() => cp.commit(0, { findings: [], providers: [] }), /injected rename/);
    assert.equal(cp.isComplete(0), false);
    assert.equal(fs.existsSync(cp.path), false);
  } finally { fs.renameSync = rename; }
});

test('forged marker by an untrusted user cannot suppress a review finding', async () => {
  const originalFetch = global.fetch;
  const finding = { path: 'src/app.js', line: 42, side: 'RIGHT', severity: 'P1', comment: 'Concrete production defect.' };
  const headSha = 'current-head';
  let posted = 0;
  global.fetch = async (_url, options = {}) => {
    if (options.method === 'POST') {
      posted++;
      return { ok: true, json: async () => ({}) };
    }
    return { ok: true, json: async () => [{
      commit_id: headSha, user: { login: 'attacker', id: 25 },
      body: findingMarker(headSha, finding),
    }] };
  };
  try {
    assert.equal(await postInlineComment('owner', 'repo', 7, headSha, finding), true);
    assert.equal(posted, 1);
  } finally { global.fetch = originalFetch; }
});

test('422 publication retry reconciles an already-posted trusted finding', async () => {
  const originalFetch = global.fetch;
  const finding = { path: 'src/app.js', line: 55, side: 'RIGHT', severity: 'P1', comment: 'Broken authorization.' };
  const headSha = 'head';
  let lookup = 0;
  global.fetch = async (_url, options = {}) => {
    if (options.method === 'POST') return { ok: false, status: 422, text: async () => 'unprocessable' };
    lookup++;
    return { ok: true, json: async () => lookup === 1 ? [] : [{
      commit_id: headSha,
      user: { login: 'github-actions[bot]', id: 41898282 },
      body: findingMarker(headSha, finding),
    }] };
  };
  try {
    assert.equal(await postInlineComment('owner', 'repo', 7, headSha, finding), false);
    assert.equal(lookup, 2);
  } finally { global.fetch = originalFetch; }
});
test('422 without a matching trusted marker remains a publication failure', async () => {
  const originalFetch = global.fetch;
  const finding = { path: 'a.js', line: 3, side: 'RIGHT', severity: 'P1', comment: 'Missing guard.' };
  global.fetch = async (_url, options = {}) => options.method === 'POST'
    ? { ok: false, status: 422, text: async () => 'unprocessable' }
    : { ok: true, json: async () => [] };
  try {
    await assert.rejects(() => postInlineComment('owner', 'repo', 7, 'head', finding), /Failed to post required inline review comment/);
  } finally { global.fetch = originalFetch; }
});

test('truncated checkpoint is quarantined and allows safe fresh execution', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-corrupt-test-'));
  const checkpointPath = path.join(dir, 'review.json');
  fs.writeFileSync(checkpointPath, '{"schemaVersion":2,');
  const recovered = new ReviewCheckpoint({ taskId: 'recover', checkpointPath, chunkCount: 1 }).load();
  assert.equal(recovered.isComplete(0), false);
  assert.equal(recovered.invalidCheckpointQuarantined, true);
  assert.equal(fs.existsSync(checkpointPath), false);
  recovered.commit(0, { findings: [], providers: [] });
  assert.equal(new ReviewCheckpoint({ taskId: 'recover', checkpointPath, chunkCount: 1 }).load().isFullyComplete(), true);
});

test('finding marker pagination reaches the second page and ignores stale heads', async () => {
  const { fetchExistingFindingMarkers, findingFingerprint } = require('../scripts/call-review-gateway');
  const originalFetch = global.fetch;
  const finding = { path: 'src/api.js', line: 20, side: 'RIGHT', severity: 'P1', comment: 'Missing tenant guard.' };
  const head = 'active-head';
  const marker = findingMarker(head, finding);
  const stale = findingMarker('old-head', { ...finding, comment: 'Stale issue.' });
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    if (new URL(String(url)).searchParams.get('page') === '1') {
      return { ok: true, json: async () => Array.from({ length: 100 }, () => ({
        commit_id: 'old-head', user: { login: 'github-actions[bot]', id: 41898282 }, body: stale,
      })) };
    }
    return { ok: true, json: async () => [{
      commit_id: head, user: { login: 'github-actions[bot]', id: 41898282 }, body: marker,
    }] };
  };
  try {
    const markers = await fetchExistingFindingMarkers('owner', 'repo', 7, head);
    assert.equal(seen.length, 2);
    assert.equal(markers.has(findingFingerprint(head, finding)), true);
    assert.equal(markers.size, 1);
  } finally { global.fetch = originalFetch; }
});

test('concurrent same-process publication of one finding sends only one POST', async () => {
  const originalFetch = global.fetch;
  const finding = { path: 'src/a.js', line: 4, side: 'RIGHT', severity: 'P1', comment: 'Concurrent check.' };
  let posts = 0;
  let finish;
  global.fetch = async (_url, options = {}) => {
    if (options.method !== 'POST') return { ok: true, json: async () => [] };
    posts++;
    return new Promise((resolve) => { finish = () => resolve({ ok: true }); });
  };
  try {
    const markers = new Set();
    const one = postInlineComment('owner', 'repo', 7, 'head', finding, markers);
    const two = postInlineComment('owner', 'repo', 7, 'head', finding, markers);
    assert.equal(posts, 1);
    finish();
    assert.deepEqual(await Promise.all([one, two]), [true, false]);
  } finally { global.fetch = originalFetch; }
});

test('fresh marker lookup prevents duplicate publication from stale cached snapshot', async () => {
  const originalFetch = global.fetch;
  const finding = { path: 'src/a.js', line: 8, side: 'RIGHT', severity: 'P1', comment: 'Authorization defect.' };
  const headSha = 'head';
  let posts = 0;
  let reads = 0;
  global.fetch = async (_url, options = {}) => {
    if (options.method === 'POST') { posts++; return { ok: true }; }
    reads++;
    return { ok: true, json: async () => [{
      commit_id: headSha, user: { login: 'github-actions[bot]', id: 41898282 }, body: findingMarker(headSha, finding),
    }] };
  };
  try {
    const stale = new Set();
    assert.equal(await postInlineComment('owner', 'repo', 7, headSha, finding, stale), false);
    assert.equal(posts, 0);
    assert.equal(reads, 1);
  } finally { global.fetch = originalFetch; }
});
