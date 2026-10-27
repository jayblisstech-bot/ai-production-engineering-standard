'use strict';

// One timebox covers fetch headers AND body, for successful and error responses.
// Streaming prevents an unbounded server body from consuming runner memory.
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function deadlineExceeded() {
  return Object.assign(new Error('APES review execution deadline exceeded.'), {
    code: 'REVIEW_DEADLINE_EXCEEDED', fallbackEligible: false,
  });
}

function remainingDeadlineMs(deadlineMs, now = Date.now()) {
  if (deadlineMs == null) return Infinity;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
    throw new Error('Invalid APES absolute review deadline.');
  }
  const remaining = deadlineMs - now;
  if (remaining <= 0) throw deadlineExceeded();
  return remaining;
}

function boundedRequestTimeoutMs(timeoutMs, deadlineMs = null, now = Date.now()) {
  if (!Number.isSafeInteger(Number(timeoutMs)) || Number(timeoutMs) <= 0) {
    throw new Error('Invalid APES request timeout.');
  }
  return Math.max(1, Math.ceil(Math.min(Number(timeoutMs), remainingDeadlineMs(deadlineMs, now))));
}

function bodyTooLarge() {
  return Object.assign(new Error('APES HTTP response body exceeds the allowed size.'), {
    code: 'HTTP_BODY_TOO_LARGE', fallbackEligible: false,
  });
}

async function readBody(res, maxBodyBytes, controller) {
  const contentLength = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    controller.abort();
    throw bodyTooLarge();
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let raw = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        controller.abort();
        throw bodyTooLarge();
      }
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  }

  // Only legacy in-memory test responses lack a Response stream. Read ONCE.
  const raw = res.ok && typeof res.json === 'function'
    ? JSON.stringify(await res.json())
    : typeof res.text === 'function' ? await res.text()
    : typeof res.json === 'function' ? JSON.stringify(await res.json()) : '';
  if (Buffer.byteLength(raw, 'utf8') > maxBodyBytes) throw bodyTooLarge();
  return raw;
}

async function fetchBufferedResponse(url, options = {}, timeoutMs, deadlineMs = null, maxBodyBytes = DEFAULT_MAX_BODY_BYTES) {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new Error('Invalid APES maximum HTTP response size.');
  }
  const effectiveMs = boundedRequestTimeoutMs(timeoutMs, deadlineMs);
  const controller = new AbortController();
  const upstream = options.signal;
  const forwardAbort = () => controller.abort();
  if (upstream?.aborted) controller.abort();
  else upstream?.addEventListener?.('abort', forwardAbort, { once: true });
  let timer;
  let didTimeOut = false;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      didTimeOut = true;
      controller.abort();
      reject(deadlineMs != null && Date.now() >= deadlineMs
        ? deadlineExceeded()
        : Object.assign(new Error('APES HTTP timed out while receiving headers or body.'), {
            code: 'REQUEST_TIMEOUT', fallbackEligible: true,
          }));
    }, effectiveMs);
  });
  try {
    const request = (async () => {
      const res = await fetch(url, { ...options, signal: controller.signal });
      const raw = await readBody(res, maxBodyBytes, controller);
      remainingDeadlineMs(deadlineMs);
      return {
        ok: res.ok, status: res.status, headers: res.headers,
        text: async () => raw, json: async () => JSON.parse(raw),
      };
    })();
    return await Promise.race([request, timeout]);
  } catch (err) {
    if (err?.code === 'HTTP_BODY_TOO_LARGE' || err?.code === 'REQUEST_TIMEOUT' ||
        err?.code === 'REVIEW_DEADLINE_EXCEEDED') throw err;
    if (deadlineMs != null && Date.now() >= deadlineMs) throw deadlineExceeded();
    if (didTimeOut || (controller.signal.aborted && !upstream?.aborted)) {
      throw Object.assign(new Error('APES HTTP request timed out.'), {
        code: 'REQUEST_TIMEOUT', fallbackEligible: true,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener?.('abort', forwardAbort);
  }
}

module.exports = {
  DEFAULT_MAX_BODY_BYTES, remainingDeadlineMs, boundedRequestTimeoutMs,
  deadlineExceeded, fetchBufferedResponse,
};
