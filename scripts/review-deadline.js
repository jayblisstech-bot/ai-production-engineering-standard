'use strict';
const { remainingDeadlineMs, boundedRequestTimeoutMs, deadlineExceeded } = require('./http-bounded');

const DEFAULT_REVIEW_BUDGET_MS = 16 * 60 * 1000;

// No retry/backoff may restart or silently overrun the absolute review budget.
async function sleepWithDeadline(ms, deadlineMs = null) {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('Invalid APES retry delay.');
  const remaining = remainingDeadlineMs(deadlineMs);
  if (ms >= remaining && Number.isFinite(remaining)) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
    throw deadlineExceeded();
  }
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  remainingDeadlineMs(deadlineMs);
}

module.exports = {
  DEFAULT_REVIEW_BUDGET_MS, remainingDeadlineMs,
  boundedRequestTimeoutMs, deadlineExceeded, sleepWithDeadline,
};
