'use strict';
const { boundedRequestTimeoutMs, remainingDeadlineMs, deadlineExceeded } = require('./review-deadline');

// The abort timer MUST include consuming the response body, not just receiving headers.
// Buffer a single body read and expose the small Response interface APES callers need.
async function fetchBufferedResponse(url, options, timeoutMs, deadlineMs = null) {
  const effectiveMs = boundedRequestTimeoutMs(timeoutMs, deadlineMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), effectiveMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    // Some test doubles implement only json(); real fetch Responses always implement text().
    let raw = typeof res.text === 'function' ? await res.text()
      : typeof res.json === 'function' ? JSON.stringify(await res.json()) : '';
    // Backward-compatible test doubles sometimes expose text() as a blank stub
    // alongside a meaningful json(); native Response bodies cannot be read twice.
    if (!raw && res.ok && typeof res.json === 'function' && !(res instanceof Response)) {
      raw = JSON.stringify(await res.json());
    }
    remainingDeadlineMs(deadlineMs);
    return {
      ok: res.ok, status: res.status, headers: res.headers,
      text: async () => raw,
      json: async () => JSON.parse(raw),
    };
  } catch (err) {
    if (deadlineMs !== null && deadlineMs !== undefined && deadlineMs <= Date.now()) throw deadlineExceeded();
    if (controller.signal.aborted) {
      const timeout = new Error('APES HTTP request timed out while receiving headers or body.');
      timeout.code = 'REQUEST_TIMEOUT';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
module.exports = { fetchBufferedResponse };
