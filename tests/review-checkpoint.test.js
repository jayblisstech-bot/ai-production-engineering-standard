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
  assert.throws(
    () => new ReviewCheckpoint({ taskId: 'task-b', checkpointPath, chunkCount: 1, headSha: 'abc', reviewTarget: 'PR:1' }).load(),
    /identity mismatch/
  );
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
  assert.throws(() => new ReviewCheckpoint({ taskId: 'plan-a', checkpointPath, chunkCount: 2, planHash: 'b'.repeat(64) }).load(), /identity mismatch/);
});

test('malformed and out-of-range completed chunks are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-invalid-test-'));
  const checkpointPath = path.join(dir, 'state.json');
  const cp = new ReviewCheckpoint({ taskId: 'invalid', checkpointPath, chunkCount: 1 });
  cp.commit(0, { findings: [], providers: [] });
  const state = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  state.completedChunks['5'] = { chunkIndex: 5, findings: [], providers: [], committedAt: new Date().toISOString() };
  fs.writeFileSync(checkpointPath, JSON.stringify(state));
  assert.throws(() => new ReviewCheckpoint({ taskId: 'invalid', checkpointPath, chunkCount: 1 }).load(), /out of range/);
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
