#!/usr/bin/env node
'use strict';

/**
 * APES hard-dollar budget reference only; NO provider/network calls.
 *
 * Production requires a trusted, atomic, durable gateway that OWNS every paid
 * provider transport, pricing catalog and verified input/output ceilings. A
 * ledger inside isolated GitHub Actions workers is not a spending limit.
 *
 * All monetary values are INTEGER micro-USD; never binary floats.
 */
const MICRO = 1000000n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function requireMicros(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error('APES_BUDGET_INVALID_' + name.toUpperCase());
  }
  return value;
}
function requireIdentifier(value, name) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new Error('APES_BUDGET_INVALID_' + name.toUpperCase());
  }
  return value;
}
function assertBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error('APES_BUDGET_INVALID_RUN_BINDING');
  }
  if (!/^[1-9][0-9]{0,17}$/.test(String(binding.runId)) ||
      !/^[1-9][0-9]{0,8}$/.test(String(binding.attempt)) ||
      !SHA_RE.test(binding.headSha || '') ||
      !SHA_RE.test(binding.baseSha || '') ||
      !SHA_RE.test(binding.pipelineSha || '')) {
    throw new Error('APES_BUDGET_INVALID_RUN_BINDING');
  }
  return Object.freeze({
    runId: String(binding.runId), attempt: String(binding.attempt),
    headSha: binding.headSha, baseSha: binding.baseSha,
    pipelineSha: binding.pipelineSha,
  });
}
function bindingKey(binding) { return JSON.stringify(assertBinding(binding)); }

/** Strict exact cents-to-micros conversion. No fractional-cent authorizations. */
function parseCapUsd(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,5})(?:\.[0-9]{1,2})?$/.test(value)) {
    throw new Error('APES_BUDGET_INVALID_USD_CAP');
  }
  const [dollars, cents = ''] = value.split('.');
  const micros = Number(BigInt(dollars) * MICRO + BigInt(cents.padEnd(2, '0') || '0') * 10000n);
  return requireMicros(micros, 'usd_cap');
}

/**
 * Authoritative quote formula to be evaluated only inside a trusted gateway.
 * All rates in micro-USD per one million tokens; integer-safe and rounded UP.
 * validUntil is an inclusive timestamp (UTC ms), not user-controlled.
 *
 * The gateway MUST enforce maximum input/output tokens at the provider transport,
 * including reasoning/thinking tokens and retries. Reject unknown fees/pricing.
 */
function ceilingMicros(catalogEntry, limits, nowMs) {
  if (!catalogEntry || !limits || !Number.isSafeInteger(nowMs)) {
    throw new Error('APES_BUDGET_INVALID_PRICE_PROOF');
  }
  const { inputMicroUsdPerMillion, outputMicroUsdPerMillion, perCallFeeMicros, validUntilMs } = catalogEntry;
  for (const [name, number] of [
    ['input_rate', inputMicroUsdPerMillion], ['output_rate', outputMicroUsdPerMillion],
    ['call_fee', perCallFeeMicros], ['price_expiry', validUntilMs],
  ]) requireMicros(number, name, name === 'call_fee');
  if (validUntilMs < nowMs) throw new Error('APES_BUDGET_PRICE_EXPIRED');
  const { maxInputTokens, maxOutputTokens } = limits;
  requireMicros(maxInputTokens, 'input_tokens');
  requireMicros(maxOutputTokens, 'output_tokens');
  const ceilDiv = (a, b) => (a + b - 1n) / b;
  const raw = ceilDiv(BigInt(maxInputTokens) * BigInt(inputMicroUsdPerMillion), MICRO)
    + ceilDiv(BigInt(maxOutputTokens) * BigInt(outputMicroUsdPerMillion), MICRO)
    + BigInt(perCallFeeMicros);
  if (raw <= 0n || raw > MAX_SAFE) throw new Error('APES_BUDGET_INVALID_QUOTED_CEILING');
  return Number(raw);
}

/**
 * In-memory REFERENCE implementation. One shared instance simulates atomic
 * reservations; NOT suitable as the durable cross-job production coordinator.
 */
class BudgetLedgerReference {
  constructor({ binding, limitMicros }) {
    this.binding = bindingKey(binding);
    this.limitMicros = requireMicros(limitMicros, 'limit_micros');
    this.usedMicros = 0;
    this.reservedMicros = 0;
    this.records = new Map();
  }
  requireBinding(binding) {
    if (bindingKey(binding) !== this.binding) throw new Error('APES_BUDGET_RUN_BINDING_MISMATCH');
  }
  remainingMicros() {
    return this.limitMicros - this.usedMicros - this.reservedMicros;
  }
  reserve({ binding, requestId, ceilingMicros: ceiling }) {
    this.requireBinding(binding);
    requireIdentifier(requestId, 'request_id');
    requireMicros(ceiling, 'reservation');
    const existing = this.records.get(requestId);
    if (existing) {
      if (existing.ceilingMicros !== ceiling) throw new Error('APES_BUDGET_RESERVATION_REPLAY_MISMATCH');
      // Never issue another paid call on a duplicate/replayed request ID.
      throw new Error('APES_BUDGET_DUPLICATE_REQUEST');
    }
    if (ceiling > this.remainingMicros()) throw new Error('APES_BUDGET_EXHAUSTED');
    const record = { requestId, ceilingMicros: ceiling, status: 'reserved', chargedMicros: null };
    this.records.set(requestId, record);
    this.reservedMicros += ceiling;
    this.assertInvariant();
    return Object.freeze({ ...record });
  }
  settle({ binding, requestId, actualMicros, verified }) {
    this.requireBinding(binding);
    const record = this.records.get(requireIdentifier(requestId, 'request_id'));
    if (!record || record.status !== 'reserved') throw new Error('APES_BUDGET_INVALID_SETTLEMENT');
    if (verified !== true && verified !== false) throw new Error('APES_BUDGET_INVALID_SETTLEMENT');
    // Without provider-verified billable usage, charge the full reservation.
    let charge = record.ceilingMicros;
    if (verified) {
      charge = requireMicros(actualMicros, 'settled_amount', true);
      if (charge > record.ceilingMicros) {
        // Indicates a broken ceiling contract; production gateway must treat
        // any such occurrence as an emergency shutdown and reconcile billing.
        throw new Error('APES_BUDGET_CEILING_VIOLATION');
      }
    }
    this.reservedMicros -= record.ceilingMicros;
    this.usedMicros += charge;
    record.chargedMicros = charge;
    record.status = 'settled';
    this.assertInvariant();
    return Object.freeze({ ...record });
  }
  // Fail closed across process loss: unresolved reservations are NEVER released.
  assertInvariant() {
    if (this.usedMicros < 0 || this.reservedMicros < 0 ||
        this.usedMicros + this.reservedMicros > this.limitMicros) {
      throw new Error('APES_BUDGET_LEDGER_CORRUPT');
    }
  }
  snapshot() {
    this.assertInvariant();
    return Object.freeze({
      limitMicros: this.limitMicros, usedMicros: this.usedMicros,
      reservedMicros: this.reservedMicros, remainingMicros: this.remainingMicros(),
      requests: this.records.size,
    });
  }
}

/**
 * Mock reference: the gateway owns transport, not GitHub's Hermes worker.
 * The quote is constructed from gateway-controlled price and token bounds.
 * Transport receives NO API key here; production gateway must hold provider
 * keys server-side and block every alternative direct egress route.
 */
async function simulateGatewayCall({ ledger, binding, requestId, catalogEntry, limits, nowMs, transport }) {
  if (!(ledger instanceof BudgetLedgerReference) || typeof transport !== 'function') {
    throw new Error('APES_BUDGET_UNTRUSTED_GATEWAY');
  }
  const quote = ceilingMicros(catalogEntry, limits, nowMs);
  ledger.reserve({ binding, requestId, ceilingMicros: quote });
  try {
    const result = await transport();
    if (!result || typeof result !== 'object') throw new Error('Invalid mock provider response');
    ledger.settle({ binding, requestId, actualMicros: result.actualBilledMicros,
      verified: result.usageVerified === true });
    return result;
  } catch (err) {
    // Even unsuccessful/time-out requests may be billable. Never release money
    // without authoritative usage reconciliation.
    try { ledger.settle({ binding, requestId, verified: false }); }
    catch (_) { /* Keep unresolved reservation if settling is unsafe. */ }
    throw err;
  }
}

/**
 * Intentionally refuses live access until a trusted, auditable, durable,
 * provider-hosting gateway is deployed and separately approved.
 */
function assertProductionReady() {
  throw new Error('APES_BUDGET_LIVE_NOT_CERTIFIED: mock ledger cannot guarantee an aggregate USD cap across GitHub jobs or external providers');
}

module.exports = {
  parseCapUsd, assertBinding, bindingKey, ceilingMicros,
  BudgetLedgerReference, simulateGatewayCall, assertProductionReady,
};
