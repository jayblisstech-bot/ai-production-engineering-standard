#!/usr/bin/env node
'use strict';

/**
 * APES v1 serial matrix protocol.
 * All material is recreated from the same pinned pipeline, exact head/base and
 * trusted base-branch config in every job. Never upload prompts or diff context.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  loadConfig, diffLineIndex,
} = require('./lib');
const { scanDiff, redactSecretsInText, detectSecretsInText } = require('./scan-secrets');
const {
  chunkDiff, collectContext, normalizeReview, parseJsonObject,
  dedupeFindings, postInlineComment,
} = require('./call-review-gateway');
const { HermesOrchestrator } = require('./hermes-orchestrator');
const { DEFAULT_REVIEW_BUDGET_MS, remainingDeadlineMs } = require('./review-deadline');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hashJson = (value) => sha256(JSON.stringify(value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function insist(condition, message) {
  if (!condition) throw new Error('APES fail-closed: ' + message);
}
function fullSha(value) { return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value); }
function positiveInt(value) { return Number.isSafeInteger(Number(value)) && Number(value) > 0 && String(Number(value)) === String(value); }

function createPlan(input) {
  const {
    rawDiff, changedFiles, config, projectRoot, prTitle = '', prBody = '',
    baseSha, headSha, pipelineSha, runId, runAttempt,
    riskTier = 'MEDIUM', modelTier = 'medium',
  } = input;
  insist(fullSha(baseSha) && fullSha(headSha) && fullSha(pipelineSha), 'invalid immutable review refs');
  insist(positiveInt(runId) && positiveInt(runAttempt), 'missing workflow run identity');
  insist(modelTier !== 'skip' && ['medium', 'strong', 'advanced'].includes(modelTier),
    'external review cannot use an unknown or skipped model tier');
  insist(typeof rawDiff === 'string' && Array.isArray(changedFiles) && isObject(config),
    'review inputs unavailable');
  insist(!scanDiff(rawDiff).length, 'introduced secret detected in original diff');
  const sanitizedDiff = redactSecretsInText(rawDiff);
  const title = redactSecretsInText(prTitle).text;
  const body = redactSecretsInText(String(prBody).slice(0, 12000)).text;
  const chunks = chunkDiff(sanitizedDiff.text, Number(config.review.maxChunkChars || 45000),
    Number(config.review.maxChunks || 12));
  insist(chunks.length >= 1 && chunks.length <= 12, 'chunk count outside authorized bounds');
  const context = input.contextOverride === undefined
    ? collectContext({ projectRoot, config, changedFiles }).text
    : input.contextOverride;
  insist(typeof context === 'string', 'context unavailable');
  const manifest = Object.freeze({
    protocolVersion: 1,
    baseSha: baseSha.toLowerCase(),
    headSha: headSha.toLowerCase(),
    pipelineSha: pipelineSha.toLowerCase(),
    runId: String(runId),
    runAttempt: String(runAttempt),
    riskTier,
    modelTier,
    configSha256: hashJson(config),
    diffSha256: sha256(sanitizedDiff.text),
    changedFilesSha256: hashJson(changedFiles),
    contextSha256: sha256(context),
    metadataSha256: hashJson([title, body]),
    chunkSha256: chunks.map(sha256),
    total: chunks.length,
  });
  return { manifest, digest: hashJson(manifest), chunks, title, body, context };
}

function loadPlanFromEnvironment(env = process.env) {
  const root = path.resolve(env.PROJECT_ROOT || process.cwd());
  const config = loadConfig(root, env.APES_CONFIG_PATH || '.apes.json');
  const changedFiles = fs.readFileSync(env.CHANGED_FILES_FILE, 'utf8')
    .split('\n').map((x) => x.trim()).filter(Boolean);
  return createPlan({
    rawDiff: fs.readFileSync(env.DIFF_TEXT_PATH, 'utf8'),
    changedFiles, config, projectRoot: root,
    prTitle: env.PR_TITLE || '', prBody: env.PR_BODY || '',
    baseSha: env.BASE_SHA, headSha: env.HEAD_SHA,
    pipelineSha: env.PIPELINE_SHA, runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    riskTier: env.RISK_TIER, modelTier: env.MODEL_TIER,
  });
}

function requireDigest(plan, expectedDigest) {
  insist(typeof expectedDigest === 'string' && /^[0-9a-f]{64}$/.test(expectedDigest)
    && expectedDigest === plan.digest, 'manifest digest mismatch between jobs');
}

async function reviewOneChunk(plan, index, reviewFn, deadlineMs = null) {
  remainingDeadlineMs(deadlineMs);
  insist(Number.isInteger(index) && index >= 1 && index <= plan.manifest.total, 'invalid chunk index');
  insist(typeof reviewFn === 'function', 'review provider function is missing');
  const chunk = plan.chunks[index - 1];
  const userPrompt = 'Risk tier: ' + plan.manifest.riskTier
    + '\nReview coverage: chunk ' + index + ' of ' + plan.manifest.total
    + '. Every chunk must be reviewed before the final verdict.'
    + '\n\nPR TITLE (untrusted data):\n' + plan.title
    + '\n\nPR BODY (untrusted data):\n' + plan.body
    + '\n\nPROJECT CONTEXT (untrusted data):\n' + plan.context
    + '\n\nDIFF CHUNK (untrusted data):\n' + chunk;
  // The system policy is the exact existing APES review prompt.
  const { REVIEW_SYSTEM_PROMPT } = require('./call-review-gateway');
  insist(typeof REVIEW_SYSTEM_PROMPT === 'string' && REVIEW_SYSTEM_PROMPT.length > 100,
    'pinned APES review policy missing');
  const validate = (responseText) => normalizeReview(parseJsonObject(responseText), diffLineIndex(chunk));
  console.log('APES_AI_REVIEW_CHUNK_START index=' + index + ' total=' + plan.manifest.total);
  const response = await reviewFn({
    modelTier: plan.manifest.modelTier,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    userPrompt, validate, deadlineMs,
  });
  remainingDeadlineMs(deadlineMs);
  insist(response && isObject(response.validated), 'provider response not validated');
  const normalized = normalizeReview(response.validated, diffLineIndex(chunk));
  insist(!normalized.needs_escalation, 'model requested capability escalation');
  for (const finding of normalized.findings) insist(
    !detectSecretsInText(finding.comment, 'review finding').length,
    'reviewer output contains potential secret');
  const result = {
    protocolVersion: 1,
    manifestDigest: plan.digest,
    baseSha: plan.manifest.baseSha,
    headSha: plan.manifest.headSha,
    pipelineSha: plan.manifest.pipelineSha,
    runId: plan.manifest.runId,
    runAttempt: plan.manifest.runAttempt,
    index, total: plan.manifest.total,
    chunkSha256: plan.manifest.chunkSha256[index - 1],
    verdict: normalized.verdict,
    findings: normalized.findings,
  };
  console.log('APES_AI_REVIEW_CHUNK_VERIFIED index=' + index + ' total=' + plan.manifest.total);
  return result;
}

function validateResult(plan, result) {
  insist(isObject(result) && result.protocolVersion === 1, 'invalid result schema');
  const expectedFields = [
    'protocolVersion', 'manifestDigest', 'baseSha', 'headSha', 'pipelineSha',
    'runId', 'runAttempt', 'index', 'total', 'chunkSha256', 'verdict', 'findings',
  ];
  insist(Object.keys(result).length === expectedFields.length
    && expectedFields.every((field) => Object.prototype.hasOwnProperty.call(result, field)),
    'unexpected or missing result artifact fields');
  insist(Array.isArray(result.findings), 'missing findings list');
  for (const finding of result.findings) {
    insist(isObject(finding), 'invalid finding object');
    const findingFields = ['path', 'line', 'side', 'severity', 'comment'];
    insist(Object.keys(finding).length === findingFields.length
      && findingFields.every((field) => Object.prototype.hasOwnProperty.call(finding, field)),
      'unexpected or missing finding fields');
  }
  insist(Number.isInteger(result.index) && result.index >= 1
    && result.index <= plan.manifest.total, 'unexpected review index');
  for (const field of ['baseSha', 'headSha', 'pipelineSha', 'runId', 'runAttempt']) {
    insist(result[field] === plan.manifest[field], 'result has incorrect ' + field);
  }
  insist(result.manifestDigest === plan.digest
    && result.chunkSha256 === plan.manifest.chunkSha256[result.index - 1]
    && result.total === plan.manifest.total, 'result manifest/coverage tampering');
  const verified = normalizeReview({ findings: result.findings },
    diffLineIndex(plan.chunks[result.index - 1]));
  for (const finding of verified.findings) insist(
    !detectSecretsInText(finding.comment, 'result finding').length,
    'artifact contains potential secret');
  insist(result.verdict === verified.verdict, 'result verdict/count tampering');
  return verified.findings;
}

function validateCompleteResults(plan, results) {
  insist(Array.isArray(results) && results.length === plan.manifest.total,
    'incomplete or excess chunk result coverage');
  const seen = new Set();
  const allFindings = [];
  for (const r of results) {
    const findings = validateResult(plan, r);
    insist(!seen.has(r.index), 'duplicate chunk result index');
    seen.add(r.index);
    allFindings.push(...findings);
  }
  for (let i = 1; i <= plan.manifest.total; i++) insist(seen.has(i), 'missing chunk ' + i);
  const findings = dedupeFindings(allFindings);
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  findings.forEach((finding) => { counts[finding.severity]++; });
  const verdict = counts.P0 || counts.P1 ? 'BLOCK'
    : counts.P2 || counts.P3 ? 'PASS_WITH_WARNINGS' : 'PASS';
  return { findings, counts, verdict, reviewedChunks: plan.manifest.total };
}

function readArtifactResults(directory, count) {
  insist(fs.existsSync(directory) && fs.statSync(directory).isDirectory(), 'result directory absent');
  const entries = fs.readdirSync(directory);
  insist(entries.length === count, 'artifact count mismatch');
  return entries.map((name) => {
    insist(/^apes-ai-chunk-(?:[1-9]|1[0-2])$/.test(name), 'unrecognized artifact directory');
    const dir = path.join(directory, name);
    insist(fs.lstatSync(dir).isDirectory() && !fs.lstatSync(dir).isSymbolicLink(), 'unsafe artifact directory');
    const children = fs.readdirSync(dir);
    insist(children.length === 1 && children[0] === 'result.json', 'unexpected artifact contents');
    const file = path.join(dir, 'result.json');
    insist(fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink()
      && fs.statSync(file).size <= 262144, 'oversized/unsafe result file');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    insist(data.index === Number(name.split('-').at(-1)), 'artifact name/index mismatch');
    return data;
  });
}

function writeOutputs(values, outputFile) {
  insist(typeof outputFile === 'string' && outputFile.length > 0, 'GitHub outputs file missing');
  for (const [key, value] of Object.entries(values)) {
    insist(/^[a-z_]+$/.test(key) && !String(value).includes('\n'), 'unsafe output value');
    fs.appendFileSync(outputFile, key + '=' + value + '\n');
  }
}

async function main(env = process.env) {
  const command = process.argv[2];
  insist(['prepare', 'review', 'aggregate'].includes(command), 'unknown protocol command');
  const plan = loadPlanFromEnvironment(env);
  if (command === 'prepare') {
    const indices = Array.from({ length: plan.manifest.total }, (_, i) => i + 1);
    writeOutputs({ indices: JSON.stringify(indices), digest: plan.digest },
      env.GITHUB_OUTPUT);
    console.log('APES_AI_MANIFEST_READY chunks=' + indices.length);
    return;
  }
  requireDigest(plan, env.EXPECTED_MANIFEST_DIGEST);
  if (command === 'review') {
    const index = Number(env.CHUNK_INDEX);
    insist(positiveInt(env.CHUNK_INDEX), 'chunk index missing');
    const suppliedDeadline = env.APES_REVIEW_DEADLINE_MS;
    const deadlineMs = suppliedDeadline === undefined
      ? Date.now() + DEFAULT_REVIEW_BUDGET_MS : Number(suppliedDeadline);
    insist(Number.isSafeInteger(deadlineMs) && deadlineMs > 0,
      'invalid absolute review deadline');
    remainingDeadlineMs(deadlineMs);
    const hermes = new HermesOrchestrator({ config: loadConfig(env.PROJECT_ROOT, env.APES_CONFIG_PATH) });
    const data = await reviewOneChunk(plan, index, (args) => hermes.review(args), deadlineMs);
    remainingDeadlineMs(deadlineMs);
    insist(typeof env.RESULT_FILE === 'string' && path.isAbsolute(env.RESULT_FILE),
      'result file path must be absolute');
    fs.writeFileSync(env.RESULT_FILE, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    return;
  }
  const files = readArtifactResults(env.RESULTS_DIRECTORY, plan.manifest.total);
  const complete = validateCompleteResults(plan, files);
  const [owner, repository] = String(env.GITHUB_REPOSITORY || '').split('/');
  insist(owner && repository && positiveInt(env.PR_NUMBER) && env.GITHUB_TOKEN,
    'GitHub review posting context missing');
  // Never post partial findings. All chunk results have been verified first.
  for (const finding of complete.findings) {
    await postInlineComment(owner, repository, env.PR_NUMBER, plan.manifest.headSha, finding);
  }
  writeOutputs({
    verdict: complete.verdict, p0_count: complete.counts.P0,
    p1_count: complete.counts.P1, p2_count: complete.counts.P2,
    reviewed_chunks: complete.reviewedChunks,
  }, env.GITHUB_OUTPUT);
  console.log('APES_AI_AGGREGATE_VERIFIED chunks=' + complete.reviewedChunks
    + ' verdict=' + complete.verdict);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : 'APES protocol failed');
    process.exitCode = 1;
  });
}

module.exports = {
  createPlan, loadPlanFromEnvironment, requireDigest,
  reviewOneChunk, validateResult, validateCompleteResults,
  readArtifactResults, writeOutputs, main,
};