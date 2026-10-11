#!/usr/bin/env node
'use strict';
/**
 * Loopback-only MOCK budget gateway. Strictly NO provider API calls or keys.
 * Production use is deliberately disabled; a real gateway needs OIDC auth,
 * exclusive paid egress and verified provider billable ceilings.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { ceilingMicros } = require('../scripts/review-dollar-budget');
const { SqliteBudgetStore } = require('./sqlite-budget-store');

const TOKEN_RATE = Object.freeze({
  inputMicroUsdPerMillion: 10000000,
  outputMicroUsdPerMillion: 10000000,
  perCallFeeMicros: 0,
});
const MOCK_MODELS = Object.freeze({
  openai: 'mock-openai', anthropic: 'mock-claude', gemini: 'mock-gemini',
});
const LIMITS = Object.freeze({ maxInputTokens: 100000, maxOutputTokens: 100000 });
function authorized(header, token) {
  if (typeof header !== 'string' || typeof token !== 'string' || token.length < 20 ||
      header.length !== token.length + 7 || !header.startsWith('Bearer ')) return false;
  return crypto.timingSafeEqual(Buffer.from(header.slice(7)), Buffer.from(token));
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 4096) throw new Error('APES_MOCK_REQUEST_TOO_LARGE');
  }
  const data = JSON.parse(body);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('APES_MOCK_BAD_JSON');
  return data;
}
function respond(res, code, data) {
  const msg = JSON.stringify(data);
  res.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(msg),
  });
  res.end(msg);
}
function createMockGateway({ store, token, now = () => Date.now(), env = process.env }) {
  if (env.APES_MOCK_GATEWAY_ONLY !== '1' ||
      !(store instanceof SqliteBudgetStore) ||
      typeof token !== 'string' || token.length < 20 ||
      typeof now !== 'function') {
    throw new Error('APES_BUDGET_LIVE_NOT_CERTIFIED: mock gateway cannot run in production');
  }
  return http.createServer(async (req, res) => {
    if (!authorized(req.headers.authorization, token)) {
      respond(res, 401, { error: 'APES_MOCK_UNAUTHORIZED' });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mock/review') {
      respond(res, 404, { error: 'APES_MOCK_ROUTE_NOT_FOUND' });
      return;
    }
    try {
      const request = await readJson(req);
      if (!Object.hasOwn(MOCK_MODELS, request.provider) ||
          request.model !== MOCK_MODELS[request.provider]) {
        throw new Error('APES_MOCK_UNKNOWN_PROVIDER_OR_MODEL');
      }
      // No client-supplied quote, price, token count or settlement value used.
      // This is a fixed deterministic sandbox price, NOT a vendor price table.
      const quote = ceilingMicros({
        ...TOKEN_RATE, validUntilMs: now() + 60000,
      }, LIMITS, now());
      store.reserve({
        grantId: request.grantId, binding: request.binding,
        requestId: request.requestId, quoteMicros: quote,
      });
      // Fake provider operation: spend full reserved quote; no real egress.
      const fail = request.simulateFailure === true;
      store.settle({
        grantId: request.grantId, binding: request.binding,
        requestId: request.requestId, verified: !fail,
        actualMicros: fail ? undefined : quote,
      });
      if (fail) {
        respond(res, 503, { error: 'APES_MOCK_PROVIDER_FAILED', budget: store.snapshot(request.grantId, request.binding) });
      } else {
        respond(res, 200, {
          mock: true, provider: request.provider, model: request.model,
          budget: store.snapshot(request.grantId, request.binding),
        });
      }
    } catch (err) {
      const code = String(err.message || 'APES_MOCK_FAILURE');
      if (code === 'APES_BUDGET_EXHAUSTED') return respond(res, 429, { error: code });
      if (code === 'APES_BUDGET_UNAUTHORIZED_GRANT') return respond(res, 403, { error: code });
      // Avoid exposing SQLite internals, paths and tokens.
      const known = /^APES_(?:BUDGET_|MOCK_)/.test(code);
      return respond(res, 400, { error: known ? code : 'APES_MOCK_BAD_REQUEST' });
    }
  });
}
async function listenLoopback(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return 'http://127.0.0.1:' + server.address().port;
}
module.exports = { createMockGateway, listenLoopback };
