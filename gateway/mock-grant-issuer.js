'use strict';
/**
 * MOCK-ONLY administrator-controlled grant issuance contract.
 * Never expose issueGrant to PR workers or HTTP request payloads.
 * In production verify signed owner authorization and persist policies
 * atomically with grants in a trusted database.
 */
const { assertBinding, parseCapUsd } = require('../scripts/review-dollar-budget');
const { validateGrantPolicy } = require('./budget-service');
function denied() { throw new Error('APES_GATEWAY_GRANT_ISSUANCE_DENIED'); }
function createMockGrantIssuer({ store, authorizeOwner, approvedPolicies }) {
  if (!store || typeof store.createGrant !== 'function' ||
      typeof authorizeOwner !== 'function' || !Array.isArray(approvedPolicies)) denied();
  const policies = new Map();
  for (const raw of approvedPolicies) {
    const policy = validateGrantPolicy(raw);
    if (policies.has(policy.grantId)) denied();
    policies.set(policy.grantId, policy);
  }
  return async function issueGrant({ approval, grantId, binding, capUsd }) {
    let run, amount;
    try { run = assertBinding(binding); amount = parseCapUsd(capUsd); }
    catch (_) { denied(); }
    const policy = policies.get(grantId);
    if (!policy || policy.repository !== run.repository || policy.prNumber !== run.prNumber) denied();
    // Approval verification is a trusted, gateway-owned callback; never accept
    // a caller-supplied truthy flag. Require exact immutable approval scope.
    let authorized = false;
    try {
      authorized = await authorizeOwner({approval, grantId, binding: run, capMicros: amount});
    } catch (_) { denied(); }
    if (authorized !== true) denied();
    // Database UNIQUE(grant_id) prevents replay even across processes.
    return store.createGrant({grantId, binding:run, capUsd});
  };
}
module.exports = { createMockGrantIssuer };
