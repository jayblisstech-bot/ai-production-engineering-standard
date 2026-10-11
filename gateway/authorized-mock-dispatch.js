'use strict';
/**
 * Mock-only composition of verified GitHub run identity and a persisted budget
 * grant. Configuration is gateway-owned. Never construct expected or grant
 * from untrusted request JSON. This is NOT an HTTP production endpoint.
 */
const { authenticateGatewayRun } = require('./run-identity-contract');
const { assertBinding, bindingKey } = require('../scripts/review-dollar-budget');
const ID = /^[A-Za-z0-9._:-]{1,128}$/;
function denied() { throw new Error('APES_GATEWAY_GRANT_DENIED'); }
function createAuthorizedMockDispatch({ service, verifyJwt, grants }) {
  if (!service || typeof service.dispatch !== 'function' ||
      typeof verifyJwt !== 'function' || !Array.isArray(grants) || grants.length === 0) denied();
  const trusted = new Map();
  for (const grant of grants) {
    if (!grant || typeof grant.grantId !== 'string' || !ID.test(grant.grantId) ||
        typeof grant.audience !== 'string' || !grant.audience.startsWith('apes-gateway:') ||
        typeof grant.confirmGitHubBinding !== 'function') denied();
    const binding = assertBinding(grant.binding);
    const key = bindingKey(binding);
    if (trusted.has(key)) denied(); // no ambiguous grants for one run
    const expected = Object.freeze({
      binding, audience: grant.audience, ownerId: grant.ownerId,
      repositoryId: grant.repositoryId, checkoutSha: grant.checkoutSha,
      ref: grant.ref, jobWorkflowRef: grant.jobWorkflowRef,
      confirmGitHubBinding: grant.confirmGitHubBinding,
    });
    trusted.set(key, Object.freeze({grantId: grant.grantId, binding, expected}));
  }
  return async function dispatch({ token, binding, requestId, provider, model }) {
    // Binding is only a lookup hint: never an authority. The trusted grant must
    // exactly match it, and authentication revalidates against trusted expected.
    let canonical;
    try { canonical = assertBinding(binding); } catch (_) { denied(); }
    const grant = trusted.get(bindingKey(canonical));
    if (!grant || typeof token !== 'string' || !token) denied();
    const run = await authenticateGatewayRun({
      token, verifyJwt, expected: grant.expected,
    });
    if (bindingKey(run) !== bindingKey(grant.binding)) denied();
    return service.dispatch({
      grantId: grant.grantId, binding: grant.binding,
      requestId, provider, model,
    });
  };
}
module.exports = { createAuthorizedMockDispatch };
