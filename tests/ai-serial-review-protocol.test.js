const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createPlan, requireDigest, reviewOneChunk, validateCompleteResults, readArtifactResults,
} = require('../scripts/ai-chunk-protocol');

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const PIPELINE = 'c'.repeat(40);
function sourceDiff(n = 9) {
  return Array.from({ length: n }, (_, i) => {
    const f = 'f' + i + '.ts';
    return 'diff --git a/' + f + ' b/' + f + '\n'
      + '--- a/' + f + '\n+++ b/' + f + '\n'
      + '@@ -0,0 +1 @@\n+const value = ' + i + ';\n';
  }).join('');
}
function makePlan(n = 9, overrides = {}) {
  return createPlan({
    rawDiff: sourceDiff(n),
    changedFiles: Array.from({ length: n }, (_, i) => 'f' + i + '.ts'),
    config: { review: { maxChunkChars: 112, maxChunks: 12 } },
    projectRoot: '/unused',
    contextOverride: 'Mocked safe project context',
    prTitle: 'Safe test PR',
    prBody: 'No unsafe source material',
    baseSha: BASE, headSha: HEAD, pipelineSha: PIPELINE,
    runId: '38154292695', runAttempt: '1',
    riskTier: 'HIGH', modelTier: 'advanced',
    ...overrides,
  });
}
function emptyResult(plan, index) {
  return {
    protocolVersion: 1,
    manifestDigest: plan.digest,
    baseSha: plan.manifest.baseSha,
    headSha: plan.manifest.headSha,
    pipelineSha: plan.manifest.pipelineSha,
    runId: plan.manifest.runId,
    runAttempt: plan.manifest.runAttempt,
    index, total: plan.manifest.total,
    chunkSha256: plan.manifest.chunkSha256[index - 1],
    verdict: 'PASS', findings: [],
  };
}
const allResults = (plan) => Array.from(
  { length: plan.manifest.total }, (_, i) => emptyResult(plan, i + 1)
);

test('Nine distinct bounded review chunks have stable manifest and correct coverage indices', () => {
  const plan = makePlan();
  assert.equal(plan.manifest.total, 9);
  assert.equal(plan.chunks.length, 9);
  assert.ok(plan.chunks.every((s) => s.length <= 112));
  assert.equal(makePlan().digest, plan.digest);
  assert.equal(validateCompleteResults(plan, allResults(plan)).reviewedChunks, 9);
  requireDigest(plan, plan.digest);
  assert.throws(() => requireDigest(plan, '0'.repeat(64)), /digest mismatch/);
});

test('One mock review per chunk returns complete manifest-bound findings without real provider calls', async () => {
  const plan = makePlan();
  const messages = [];
  const results = [];
  for (let i = 1; i <= 9; i++) {
    const result = await reviewOneChunk(plan, i, async ({ modelTier, systemPrompt, userPrompt, validate }) => {
      assert.equal(modelTier, 'advanced');
      assert.ok(systemPrompt.includes('independent production pull-request reviewer'));
      assert.ok(userPrompt.includes('chunk ' + i + ' of 9'));
      messages.push(i);
      return { validated: validate(JSON.stringify({ findings: [] })) };
    });
    results.push(result);
  }
  assert.deepEqual(messages, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(validateCompleteResults(plan, results).verdict, 'PASS');
});

test('An unfinished or cancelled chunk 3 fails closed with no partial aggregate verdict', () => {
  const plan = makePlan();
  const results = allResults(plan);
  results.splice(2, 1);
  assert.throws(() => validateCompleteResults(plan, results), /incomplete/);
  results.push({ ...results[1], index: 2 });
  assert.throws(() => validateCompleteResults(plan, results), /duplicate|manifest\/coverage tampering/);
});

test('Duplicate, missing and unexpected chunk indices are never accepted', () => {
  const plan = makePlan();
  const cases = [
    allResults(plan).slice(1),
    allResults(plan).map((x, i) => i === 8 ? { ...x, index: 1, chunkSha256: plan.manifest.chunkSha256[0] } : x),
    [...allResults(plan), emptyResult(plan, 1)],
  ];
  for (const results of cases) {
    assert.throws(() => validateCompleteResults(plan, results), /incomplete|duplicate/);
  }
});

test('Exact PR head, base, pipeline, workflow run/attempt and chunk hash are all bound', () => {
  const plan = makePlan();
  for (const [field, value] of [
    ['headSha', 'd'.repeat(40)],
    ['baseSha', 'd'.repeat(40)],
    ['pipelineSha', 'd'.repeat(40)],
    ['runId', '1234'],
    ['runAttempt', '2'],
    ['manifestDigest', '0'.repeat(64)],
    ['chunkSha256', '0'.repeat(64)],
  ]) {
    const tampered = allResults(plan);
    tampered[0] = { ...tampered[0], [field]: value };
    assert.throws(() => validateCompleteResults(plan, tampered), /incorrect|tampering/);
  }
  assert.notEqual(makePlan(9, { runAttempt: '2' }).digest, plan.digest);
  assert.notEqual(makePlan(9, { prTitle: 'Changed' }).digest, plan.digest);
  assert.notEqual(makePlan(9, { headSha: 'd'.repeat(40) }).digest, plan.digest);
});

test('Untrusted model finding outside the reviewed chunk cannot pass validation', async () => {
  const plan = makePlan();
  const chunkIndex = 1;
  await assert.rejects(
    reviewOneChunk(plan, chunkIndex, async ({ validate }) => ({
      validated: validate(JSON.stringify({ findings: [{
        path: 'unreviewed-file.ts', line: 1, side: 'RIGHT', severity: 'P1',
        comment: 'Untrusted fake finding',
      }] })),
    })),
    /not present in the reviewed diff/
  );
});

test('Valid P0 or P1 findings block the complete result; provider verdict tampering is rejected', () => {
  const plan = makePlan();
  const findings = [{ path: 'f0.ts', line: 1, side: 'RIGHT', severity: 'P1', comment: 'Mock high risk' }];
  const r = allResults(plan);
  r[0] = { ...r[0], findings, verdict: 'BLOCK' };
  const result = validateCompleteResults(plan, r);
  assert.equal(result.verdict, 'BLOCK');
  assert.equal(result.counts.P1, 1);
  r[0] = { ...r[0], verdict: 'PASS' };
  assert.throws(() => validateCompleteResults(plan, r), /verdict\/count tampering/);
});

test('Model output or result artifacts containing credential-like material are blocked', async () => {
  const plan = makePlan();
  const findings = [{
    path: 'f0.ts', line: 1, side: 'RIGHT', severity: 'P3',
    comment: 'Detected secret ghp_' + 'A'.repeat(36),
  }];
  await assert.rejects(
    reviewOneChunk(plan, 1, async ({ validate }) => ({
      validated: validate(JSON.stringify({ findings })),
    })),
    /reviewer output contains potential secret/
  );
  const results = allResults(plan);
  results[0] = { ...results[0], findings, verdict: 'PASS_WITH_WARNINGS' };
  assert.throws(() => validateCompleteResults(plan, results), /artifact contains potential secret/);
});

test('Complete artifact coverage checks filenames, sizes, index consistency and content', () => {
  const plan = makePlan();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-ai-review-'));
  try {
    allResults(plan).forEach((r) => {
      const p = path.join(root, 'apes-ai-chunk-' + r.index);
      fs.mkdirSync(p);
      fs.writeFileSync(path.join(p, 'result.json'), JSON.stringify(r));
    });
    assert.equal(validateCompleteResults(plan, readArtifactResults(root, 9)).verdict, 'PASS');
    fs.renameSync(path.join(root, 'apes-ai-chunk-9'), path.join(root, 'apes-ai-chunk-10'));
    assert.throws(() => readArtifactResults(root, 9), /name\/index mismatch/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Symlinked artifact directories are refused before any model-result aggregation', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-artifact-symlink-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-external-result-'));
  try {
    fs.writeFileSync(path.join(target, 'result.json'), JSON.stringify({ index: 1 }));
    fs.symlinkSync(target, path.join(root, 'apes-ai-chunk-1'), 'dir');
    assert.throws(() => readArtifactResults(root, 1), /unsafe artifact directory/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('Over-budget chunks, unknown model tier, invalid refs and introduced secrets fail closed', () => {
  assert.throws(() => makePlan(13), /configured maximum/);
  assert.throws(() => makePlan(9, { modelTier: 'skip' }), /skipped model tier/);
  assert.throws(() => makePlan(9, { pipelineSha: 'main' }), /immutable review refs/);
  assert.throws(() => makePlan(9, {
    rawDiff: 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+API_KEY=ghp_' + 'a'.repeat(36) + '\n',
  }), /secret/);
});

test('Workflow enforces serial max-parallel 1 with separate timeout and fail-closed aggregate', () => {
  const workflow = fs.readFileSync(
    path.join(__dirname, '../.github/workflows/ai-review.yml'), 'utf8'
  );
  assert.ok(workflow.includes('  ai-manifest:'));
  assert.ok(workflow.includes('  ai-review-chunk:'));
  assert.ok(workflow.includes('  ai-review:\n'));
  const matrix = workflow.split('  ai-review-chunk:\n')[1].split('  ai-review:\n')[0];
  assert.ok(matrix.includes('max-parallel: 1'));
  assert.ok(matrix.includes('fail-fast: true'));
  assert.ok(matrix.includes('timeout-minutes: 20'));
  assert.ok(matrix.includes('ai-chunk-protocol.js review'));
  assert.ok(!matrix.includes('continue-on-error: true'));
  assert.ok(workflow.includes('ai-chunk-protocol.js aggregate'));
  assert.ok(workflow.includes("needs.ai-review-chunk.result == 'success'"));
  assert.ok(workflow.includes('AI_RESULT: \${{ needs.ai-review.result }}'));
  assert.ok(workflow.includes('retention-days: 1'));
  assert.ok(!workflow.includes('max-parallel: 2'));
});
