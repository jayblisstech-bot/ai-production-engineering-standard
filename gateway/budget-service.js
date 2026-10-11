'use strict';
/**
 * APES storage-independent budget SERVICE for isolated mock gateways.
 *
 * This module imports no database or cloud SDK. Its only persistence boundary
 * is an atomic store with snapshot(), reserve(), and settle(). Each grant is
 * repository + PR + immutable run-bound and carries its own allowlisted models.
 *
 * The service is MOCK ONLY. Production requires OIDC identity validation,
 * exclusive vendor-secret custody, real billability maxima, and controlled
 * egress. No direct provider credentials or external provider URLs live here.
 */
const { assertBinding, ceilingMicros } = require('../scripts/review-dollar-budget');
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

function requireStore(store) {
  if (!store || ['snapshot', 'reserve', 'settle'].some((k) => typeof store[k] !== 'function')) {
    throw new Error('APES_BUDGET_STORAGE_ADAPTER_REQUIRED');
  }
  return store;
}
function validateGrantPolicy(policy) {
  if (!policy || typeof policy !== 'object' ||
      typeof policy.grantId !== 'string' || !ID.test(policy.grantId) ||
      typeof policy.repository !== 'string' ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository) ||
      !/^[1-9][0-9]{0,8}$/.test(String(policy.prNumber)) ||
      !policy.models || typeof policy.models !== 'object') {
    throw new Error('APES_BUDGET_INVALID_GRANT_POLICY');
  }
  const models = Object.create(null);
  for (const [provider, names] of Object.entries(policy.models)) {
    if (!['openai', 'anthropic', 'gemini'].includes(provider) ||
        !Array.isArray(names) || !names.length ||
        names.some((name) => typeof name !== 'string' || !ID.test(name))) {
      throw new Error('APES_BUDGET_INVALID_GRANT_POLICY');
    }
    models[provider] = Object.freeze([...new Set(names)]);
  }
  if (!Object.keys(models).length) throw new Error('APES_BUDGET_INVALID_GRANT_POLICY');
  return Object.freeze({
    grantId: policy.grantId, repository: policy.repository.toLowerCase(),
    prNumber: String(policy.prNumber), models: Object.freeze(models),
  });
}
class BudgetGatewayService {
  constructor({ store, policies, pricingCatalog, transport, now = () => Date.now(), mockOnly = false }) {
    if (mockOnly !== true) throw new Error('APES_BUDGET_LIVE_NOT_CERTIFIED');
    this.store = requireStore(store);
    if (!Array.isArray(policies) || !policies.length || !pricingCatalog ||
        typeof pricingCatalog !== 'object' || typeof transport !== 'function' ||
        typeof now !== 'function') throw new Error('APES_BUDGET_INVALID_SERVICE_CONFIG');
    this.policies = new Map();
    for (const entry of policies) {
      const policy = validateGrantPolicy(entry);
      if (this.policies.has(policy.grantId)) throw new Error('APES_BUDGET_DUPLICATE_POLICY');
      this.policies.set(policy.grantId, policy);
    }
    this.catalog = pricingCatalog;
    this.transport = transport;
    this.now = now;
  }
  policyFor(grantId, binding) {
    const run = assertBinding(binding);
    const policy = this.policies.get(grantId);
    if (!policy || policy.repository !== run.repository || policy.prNumber !== run.prNumber) {
      throw new Error('APES_BUDGET_REPOSITORY_POLICY_DENIED');
    }
    // Validate that this grant is persisted and bound to this exact run.
    this.store.snapshot(grantId, run);
    return { policy, run };
  }
  async dispatch({ grantId, binding, requestId, provider, model, simulateFailure = false }) {
    const { policy, run } = this.policyFor(grantId, binding);
    if (!ID.test(String(requestId)) || typeof requestId !== 'string') {
      throw new Error('APES_BUDGET_INVALID_REQUEST_ID');
    }
    if (!Object.hasOwn(policy.models, provider) ||
        !policy.models[provider].includes(model)) {
      throw new Error('APES_BUDGET_MODEL_NOT_APPROVED_FOR_REPOSITORY');
    }
    const price = this.catalog[provider] && this.catalog[provider][model];
    if (!price || !price.rates || !price.limits) {
      throw new Error('APES_BUDGET_MISSING_APPROVED_PRICE');
    }
    const quoteMicros = ceilingMicros(price.rates, price.limits, this.now());
    // Cross-job atomicity MUST be provided by the store, not this JS function.
    this.store.reserve({ grantId, binding: run, requestId, quoteMicros });
    let success = false;
    try {
      // Transport is injected; the mock harness never opens vendor connections.
      const response = await this.transport({ provider, model, simulateFailure });
      if (!response || response.mock !== true) {
        throw new Error('APES_BUDGET_UNTRUSTED_PROVIDER_RESULT');
      }
      this.store.settle({ grantId, binding: run, requestId, verified: true, actualMicros: quoteMicros });
      success = true;
      return { mock: true, provider, model, budget: this.store.snapshot(grantId, run) };
    } catch (error) {
      if (!success) {
        // A failed or uncertain provider request may still be billable.
        // Conservatively charge full reservation if safely possible.
        try { this.store.settle({ grantId, binding: run, requestId, verified: false }); }
        catch (_) { /* Existing reservation stays locked until reconciliation. */ }
      }
      throw error;
    }
  }
}
module.exports = { BudgetGatewayService, validateGrantPolicy, requireStore };
