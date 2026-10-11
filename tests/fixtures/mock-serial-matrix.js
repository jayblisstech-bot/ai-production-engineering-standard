#!/usr/bin/env node
'use strict';
/* CI-only synthetic matrix smoke test: no external provider, secrets, or PR code execution. */
const path = require('node:path');
const fs = require('node:fs');
const { createPlan, requireDigest, reviewOneChunk, readArtifactResults,
  validateCompleteResults, writeOutputs } = require('../../scripts/ai-chunk-protocol');

function buildMockPlan(env = process.env) {
  const ids = [0, 1, 2];
  const rawDiff = ids.map((i) => {
    const file = 'mock-' + i + '.ts';
    return 'diff --git a/' + file + ' b/' + file + '\n'
      + '--- a/' + file + '\n+++ b/' + file + '\n'
      + '@@ -0,0 +1 @@\n+const mockValue = ' + i + ';\n';
  }).join('');
  return createPlan({
    rawDiff,
    changedFiles: ids.map((i) => 'mock-' + i + '.ts'),
    config: { review: { maxChunkChars: 120, maxChunks: 12 } },
    projectRoot: '/unused',
    contextOverride: 'Synthetic test-only text',
    prTitle: 'APES mock CI',
    prBody: 'No credentials or provider access',
    baseSha: env.PR_BASE_SHA,
    headSha: env.PR_HEAD_SHA,
    pipelineSha: env.PR_HEAD_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    riskTier: 'MEDIUM', modelTier: 'medium',
  });
}

async function main() {
  const plan = buildMockPlan();
  const command = process.argv[2];
  if (command === 'prepare') {
    writeOutputs({
      indices: JSON.stringify(plan.chunks.map((_, i) => i + 1)),
      digest: plan.digest,
    }, process.env.GITHUB_OUTPUT);
  } else if (command === 'review') {
    requireDigest(plan, process.env.EXPECTED_MANIFEST_DIGEST);
    const index = Number(process.env.CHUNK_INDEX);
    const result = await reviewOneChunk(plan, index, async ({ validate }) => ({
      validated: validate(JSON.stringify({ findings: [] })),
    }));
    const out = path.resolve(process.env.GITHUB_WORKSPACE, 'result.json');
    fs.writeFileSync(out, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  } else if (command === 'aggregate') {
    requireDigest(plan, process.env.EXPECTED_MANIFEST_DIGEST);
    const dir = path.resolve(process.env.GITHUB_WORKSPACE, 'mock-results');
    const results = readArtifactResults(dir, plan.manifest.total);
    const verdict = validateCompleteResults(plan, results);
    if (verdict.verdict !== 'PASS' || verdict.reviewedChunks !== plan.manifest.total) {
      throw new Error('Mock matrix aggregate incomplete or blocked');
    }
    console.log('Mock APES GitHub matrix complete: ' + verdict.reviewedChunks + '/' + plan.manifest.total);
  } else {
    throw new Error('Unknown synthetic CI command');
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
