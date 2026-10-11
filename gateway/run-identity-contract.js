'use strict';
/**
 * MOCK-ONLY contract for a future GitHub OIDC-authenticated APES gateway.
 * The verifier MUST perform full JWT signature, issuer, audience, expiry and
 * nonce validation against trusted OIDC keys. This module never parses an
 * unverified JWT and never issues grants or accesses provider credentials.
 */
const { assertBinding } = require('../scripts/review-dollar-budget');
const SHA = /^[a-f0-9]{40}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
function deny() { throw new Error('APES_GATEWAY_IDENTITY_DENIED'); }
function stringEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a === b;
}
function verifiedRunClaims(claims, expected) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims) ||
      !expected || typeof expected !== 'object') deny();
  const run = assertBinding(expected.binding);
  if (!stringEqual(claims.iss, 'https://token.actions.githubusercontent.com') ||
      !stringEqual(claims.aud, expected.audience) ||
      typeof expected.audience !== 'string' || !expected.audience.startsWith('apes-gateway:') ||
      !stringEqual(claims.repository, run.repository) ||
      !stringEqual(claims.event_name, 'pull_request') ||
      !stringEqual(claims.repository_owner_id, String(expected.ownerId)) ||
      !stringEqual(claims.repository_id, String(expected.repositoryId)) ||
      !stringEqual(claims.run_id, run.runId) ||
      !stringEqual(claims.run_attempt, run.runAttempt) ||
      !stringEqual(claims.sha, run.headSha) ||
      !stringEqual(claims.workflow_sha, run.pipelineSha) ||
      !stringEqual(claims.ref, expected.ref) ||
      !stringEqual(claims.job_workflow_ref, expected.jobWorkflowRef) ||
      !SHA.test(run.headSha) || !SHA.test(run.baseSha) || !SHA.test(run.pipelineSha) ||
      !DECIMAL.test(run.runId) || !DECIMAL.test(run.runAttempt) ||
      !DECIMAL.test(String(expected.ownerId)) || !DECIMAL.test(String(expected.repositoryId))) deny();
  // OIDC has no authoritative pull-request base SHA or budget grant. These must
  // be independently read and pinned by a trusted server-side GitHub API client.
  if (typeof expected.confirmGitHubBinding !== 'function') deny();
  return Object.freeze({ ...run, repositoryId: String(expected.repositoryId) });
}
async function authenticateGatewayRun({ token, verifyJwt, expected }) {
  if (typeof token !== 'string' || !token || typeof verifyJwt !== 'function') deny();
  if (!expected || typeof expected.confirmGitHubBinding !== 'function') deny();
  // Caller-provided JSON claims are NEVER accepted in lieu of verified JWT.
  let claims;
  try { claims = await verifyJwt(token, { issuer: 'https://token.actions.githubusercontent.com', audience: expected.audience }); }
  catch (_) { deny(); }
  const run = verifiedRunClaims(claims, expected);
  let confirmed = false;
  try { confirmed = await expected.confirmGitHubBinding(run, expected.binding); }
  catch (_) { deny(); }
  if (confirmed !== true) deny();
  return run;
}
module.exports = { authenticateGatewayRun, verifiedRunClaims };
