#!/usr/bin/env node
'use strict';
/**
 * Storage-agnostic loopback-only mock APES gateway. No vendor traffic or keys.
 * Production blocked: OIDC grant identity and exclusive paid egress absent.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const { BudgetGatewayService } = require('./budget-service');

const MOCK_MODELS = Object.freeze({
  openai: 'mock-openai', anthropic: 'mock-claude', gemini: 'mock-gemini',
});
const RATES = Object.freeze({
  inputMicroUsdPerMillion: 10000000, outputMicroUsdPerMillion: 10000000,
  perCallFeeMicros: 0, validUntilMs: 4102444800000,
});
const LIMITS = Object.freeze({ maxInputTokens: 100000, maxOutputTokens: 100000 });
const MOCK_CATALOG = Object.freeze({
  openai: { 'mock-openai': { rates: RATES, limits: LIMITS } },
  anthropic: { 'mock-claude': { rates: RATES, limits: LIMITS } },
  gemini: { 'mock-gemini': { rates: RATES, limits: LIMITS } },
});
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
function createMockGateway({ store, policies, token, now = () => Date.now(), env = process.env }) {
  if (env.APES_MOCK_GATEWAY_ONLY !== '1' ||
      typeof token !== 'string' || token.length < 20 ||
      typeof now !== 'function') {
    throw new Error('APES_BUDGET_LIVE_NOT_CERTIFIED: mock gateway cannot run in production');
  }
  const service = new BudgetGatewayService({
    store, policies, pricingCatalog: MOCK_CATALOG,
    now, mockOnly: true,
    transport: async ({ simulateFailure }) => {
      if (simulateFailure) throw new Error('APES_MOCK_PROVIDER_FAILED');
      return { mock: true };
    },
  });
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
      const result = await service.dispatch({
        grantId: request.grantId, binding: request.binding,
        requestId: request.requestId, provider: request.provider,
        model: request.model, simulateFailure: request.simulateFailure === true,
      });
      respond(res, 200, result);
    } catch (err) {
      const code = String(err.message || 'APES_MOCK_FAILURE');
      if (code === 'APES_BUDGET_EXHAUSTED') return respond(res, 429, { error: code });
      if (code === 'APES_BUDGET_UNAUTHORIZED_GRANT' ||
          code === 'APES_BUDGET_REPOSITORY_POLICY_DENIED' ||
          code === 'APES_BUDGET_MODEL_NOT_APPROVED_FOR_REPOSITORY') {
        return respond(res, 403, { error: code });
      }
      if (code === 'APES_MOCK_PROVIDER_FAILED') return respond(res, 503, { error: code });
      // Avoid exposing SQLite internals, paths and credentials.
      const known = /^APES_(?:BUDGET_|MOCK_)/.test(code);
      respond(res, 400, { error: known ? code : 'APES_MOCK_BAD_REQUEST' });
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
module.exports = { createMockGateway, listenLoopback, MOCK_CATALOG };
