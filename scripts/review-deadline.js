'use strict';

// A shared absolute deadline prevents credential/model failover from restarting the time budget.
const DEFAULT_REVIEW_BUDGET_MS = 15 * 60 * 1000;
const PUBLICATION_RESERVE_MS = 90 * 1000;

function deadlineExceeded() {
  return Object.assign(new Error('APES review execution deadline exceeded; refusing incomplete review success.'), {
    code: 'REVIEW_DEADLINE_EXCEEDED', fallbackEligible: false,
  });
}

function remainingDeadlineMs(deadlineMs, now = Date.now()) {
  if (deadlineMs === null || deadlineMs === undefined) return Infinity;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new Error('APES review deadline must be an absolute positive integer in epoch milliseconds.');
  const remaining = deadlineMs - now;
  if (remaining <= 0) throw deadlineExceeded();
  return remaining;
}

function boundedRequestTimeoutMs(timeoutMs, deadlineMs, now = Date.now()) {
  const configured = Number(timeoutMs);
  if (!Number.isFinite(configured) || configured <= 0) throw new Error('Invalid provider request timeout.');
  return Math.max(1, Math.ceil(Math.min(configured, remainingDeadlineMs(deadlineMs, now))));
}

module.exports = { DEFAULT_REVIEW_BUDGET_MS, PUBLICATION_RESERVE_MS, deadlineExceeded, remainingDeadlineMs, boundedRequestTimeoutMs };
