#!/usr/bin/env node
/**
 * Gemini credential-pool client.
 *
 * Core invariants:
 *   - 401/403/429 are credential/project-sensitive, so rotate credentials on the same model.
 *   - repeated network/5xx failures are evaluated across independent credentials before model
 *     fallback. APES credentials are expected to represent independent account/project capacity
 *     boundaries; transient failure on one credential must not discard healthy capacity on others.
 *   - API keys are never returned in telemetry.
 */

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parseGeminiCredentials(env = process.env) {
  const raw = env.GEMINI_API_KEYS_JSON;
  const credentials = [];
  if (raw) {
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (err) { throw new Error(`GEMINI_API_KEYS_JSON must be valid JSON: ${err.message}`); }
    if (!Array.isArray(parsed) || !parsed.length) throw new Error('GEMINI_API_KEYS_JSON must be a non-empty JSON array.');
    parsed.forEach((entry, index) => {
      const normalized = typeof entry === 'string' ? { key: entry } : entry;
      if (!normalized || typeof normalized !== 'object' || typeof normalized.key !== 'string' || !normalized.key.trim()) {
        throw new Error(`Gemini credential entry ${index} must be a key string or {id,key} object.`);
      }
      const id = typeof normalized.id === 'string' && normalized.id.trim() ? normalized.id.trim() : `gemini-project-${String(index + 1).padStart(2, '0')}`;
      credentials.push({ id, key: normalized.key.trim() });
    });
  } else if (env.GEMINI_API_KEY) {
    credentials.push({ id: 'gemini-project-01', key: env.GEMINI_API_KEY.trim() });
  }
  const seenIds = new Set();
  const seenKeys = new Set();
  for (const c of credentials) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(c.id)) throw new Error(`Gemini credential id must be an opaque 1-64 character token using only letters, numbers, dot, underscore, or hyphen: ${c.id}`);
    if (seenIds.has(c.id)) throw new Error(`Duplicate Gemini credential id: ${c.id}`);
    if (seenKeys.has(c.key)) throw new Error(`Duplicate Gemini credential material detected for id: ${c.id}`);
    seenIds.add(c.id);
    seenKeys.add(c.key);
  }
  return credentials;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function retryAfterMs(res, fallbackMs) {
  const value = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
  if (!value) return fallbackMs;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(fallbackMs, Math.ceil(seconds * 1000));
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(fallbackMs, date - Date.now());
  return fallbackMs;
}

function extractGeminiText(data) {
  return data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
}

class GeminiCredentialPool {
  constructor(credentials, options = {}) {
    if (!Array.isArray(credentials) || !credentials.length) throw new Error('GeminiCredentialPool requires at least one credential.');
    this.credentials = credentials.map((c) => ({ ...c, disabled: false }));
    this.cursor = 0;
    this.modelCooldowns = new Map();
    this.transientModelCooldowns = new Map();
    this.modelUnavailable = new Set();
    this.timeoutMs = Number(options.timeoutMs || 90000);
    this.cooldown429Ms = Number(options.cooldown429Ms || 60000);
    this.transientCooldownMs = Number(options.transientCooldownMs || 15000);
    this.maxRetriesPerCredential = Number(options.maxRetriesPerCredential ?? 1);
    this.backoffBaseMs = Number(options.backoffBaseMs || 500);
    this.telemetry = [];
  }

  stateKey(id, model) { return `${id}:${model}`; }

  availableCredentials(model) {
    const now = Date.now();
    const out = [];
    for (let offset = 0; offset < this.credentials.length; offset++) {
      const idx = (this.cursor + offset) % this.credentials.length;
      const c = this.credentials[idx];
      if (c.disabled) continue;
      const blockedUntil = this.modelCooldowns.get(this.stateKey(c.id, model)) || 0;
      if (blockedUntil <= now) out.push({ credential: c, index: idx });
    }
    return out;
  }

  markCooldown(credentialId, model, ms, reason) {
    const cooldownMs = Math.max(0, Number(ms) || 0);
    this.modelCooldowns.set(this.stateKey(credentialId, model), Date.now() + cooldownMs);
    this.telemetry.push({ provider: 'gemini', credentialId, model, event: 'cooldown', reason, cooldownMs });
  }

  markTransientModelCooldown(model, reason) {
    const cooldownMs = Math.max(1000, this.transientCooldownMs);
    this.transientModelCooldowns.set(model, Date.now() + cooldownMs);
    this.telemetry.push({ provider: 'gemini', model, event: 'model-transient-cooldown', reason, cooldownMs });
  }

  disableCredential(credentialId, reason) {
    const c = this.credentials.find((x) => x.id === credentialId);
    if (c) c.disabled = true;
    this.telemetry.push({ provider: 'gemini', credentialId, event: 'credential-disabled', reason });
  }

  async request(model, systemPrompt, userPrompt, options = {}) {
    if (this.modelUnavailable.has(model)) {
      throw Object.assign(new Error(`Gemini model ${model} is marked unavailable for this run.`), { code: 'MODEL_UNAVAILABLE', fallbackEligible: true });
    }
    const modelCooldownUntil = this.transientModelCooldowns.get(model) || 0;
    if (modelCooldownUntil > Date.now()) {
      throw Object.assign(new Error(`Gemini model ${model} is cooling down after repeated transient provider failures.`), { code: 'MODEL_TRANSIENT_UNAVAILABLE', fallbackEligible: true });
    }

    const thinkingLevel = options.thinkingLevel || null;
    if (thinkingLevel && !['low', 'medium', 'high'].includes(thinkingLevel)) {
      throw new Error(`Unsupported Gemini thinking level: ${thinkingLevel}`);
    }

    const candidates = this.availableCredentials(model);
    if (!candidates.length) throw Object.assign(new Error(`No healthy Gemini credentials remain for model ${model}.`), { code: 'MODEL_POOL_EXHAUSTED', fallbackEligible: true });

    const errors = [];
    let transientCredentialFailures = 0;

    for (const { credential, index } of candidates) {
      this.cursor = (index + 1) % this.credentials.length;
      let credentialTransientFailure = false;

      for (let attempt = 0; attempt <= this.maxRetriesPerCredential; attempt++) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(credential.key)}`;
        let res;
        try {
          const generationConfig = { responseMimeType: 'application/json' };
          if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };

          res = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
              generationConfig,
            }),
          }, this.timeoutMs);
        } catch (err) {
          errors.push(`${credential.id}: network/timeout`);
          this.telemetry.push({ provider: 'gemini', credentialId: credential.id, model, event: 'network-error', attempt: attempt + 1 });
          if (attempt < this.maxRetriesPerCredential) {
            await sleep(this.backoffBaseMs * (2 ** attempt) + Math.floor(Math.random() * 250));
            continue;
          }
          this.markCooldown(credential.id, model, this.transientCooldownMs, 'network');
          credentialTransientFailure = true;
          break;
        }

        if (res.ok) {
          const data = await res.json();
          const text = extractGeminiText(data);
          if (!text) {
            errors.push(`${credential.id}: empty response`);
            this.telemetry.push({ provider: 'gemini', credentialId: credential.id, model, event: 'empty-response' });
            this.markCooldown(credential.id, model, this.transientCooldownMs, 'empty-response');
            break;
          }
          this.telemetry.push({ provider: 'gemini', credentialId: credential.id, model, event: 'success', thinkingLevel });
          return { text, provider: 'gemini', model, credentialId: credential.id };
        }

        const body = await res.text();
        // HTTP status and structured provider codes take precedence over textual hints.
        // Quota errors frequently mention input_token_count and token limits.
        let errorCode = '';
        try {
          const parsed = JSON.parse(body);
          errorCode = String(parsed?.error?.details?.find?.((d) => d?.reason || d?.metadata?.reason)?.reason
            || parsed?.error?.status || parsed?.error?.code || '');
          if (!/API_KEY_INVALID/i.test(errorCode) && Array.isArray(parsed?.error?.details)) {
            if (parsed.error.details.some((d) => /API_KEY_INVALID/i.test(JSON.stringify(d)))) errorCode = 'API_KEY_INVALID';
          }
        } catch (_) { /* Text-only provider response. */ }
        if ((res.status === 400 || res.status === 401) && /API_KEY_INVALID|API_KEY_EXPIRED|INVALID_API_KEY/i.test(errorCode)) {
          errors.push(`${credential.id}: invalid API credential`);
          this.disableCredential(credential.id, 'invalid-api-key');
          break;
        }
        if (res.status === 400 && /(?:context\\s*(?:window|length)|maximum\\s*context|input\\s*token\\s*count).{0,100}(?:exceed|too\\s*(?:long|large)|limit)|(?:exceed|too\\s*(?:long|large)).{0,100}(?:context\\s*(?:window|length)|input\\s*token)/i.test(body)) {
          throw Object.assign(new Error('Gemini context window exceeded.'), { code: 'CONTEXT_OVERFLOW', fallbackEligible: false });
        }
        if (res.status === 429) {
          const cooldownMs = retryAfterMs(res, this.cooldown429Ms);
          errors.push(`${credential.id}: HTTP 429`);
          this.markCooldown(credential.id, model, cooldownMs, 'rate-limit');
          break;
        }
        if (res.status === 401) {
          errors.push(`${credential.id}: HTTP 401`);
          this.disableCredential(credential.id, 'HTTP 401');
          break;
        }
        if (res.status === 403) {
          errors.push(`${credential.id}: HTTP 403`);
          this.modelCooldowns.set(this.stateKey(credential.id, model), Number.MAX_SAFE_INTEGER);
          this.telemetry.push({ provider: 'gemini', credentialId: credential.id, model, event: 'model-forbidden', status: 403 });
          break;
        }
        if (res.status === 404) {
          this.modelUnavailable.add(model);
          this.telemetry.push({ provider: 'gemini', model, event: 'model-unavailable', status: 404 });
          throw Object.assign(new Error(`Gemini model ${model} is unavailable (404).`), { code: 'MODEL_UNAVAILABLE', fallbackEligible: true });
        }
        if (res.status >= 500) {
          errors.push(`${credential.id}: HTTP ${res.status}`);
          this.telemetry.push({ provider: 'gemini', credentialId: credential.id, model, event: 'server-error', status: res.status, attempt: attempt + 1 });
          if (attempt < this.maxRetriesPerCredential) {
            await sleep(this.backoffBaseMs * (2 ** attempt) + Math.floor(Math.random() * 250));
            continue;
          }
          this.markCooldown(credential.id, model, this.transientCooldownMs, `HTTP ${res.status}`);
          credentialTransientFailure = true;
          break;
        }
        throw Object.assign(new Error(`Gemini ${model} failed with HTTP ${res.status}: ${body.slice(0, 500)}`), { code: 'REQUEST_REJECTED', fallbackEligible: false });
      }

      if (credentialTransientFailure) {
        transientCredentialFailures += 1;
        if (transientCredentialFailures >= this.credentials.length) {
          this.markTransientModelCooldown(model, 'repeated-network-or-5xx');
          throw Object.assign(
            new Error(`Gemini model ${model} hit transient provider failures across ${transientCredentialFailures} distinct credentials; falling back only after every independent credential is exhausted. ${errors.join(' | ')}`),
            { code: 'MODEL_TRANSIENT_UNAVAILABLE', fallbackEligible: true }
          );
        }
      }
    }

    throw Object.assign(new Error(`Gemini credential pool exhausted for model ${model}. ${errors.join(' | ')}`), { code: 'MODEL_POOL_EXHAUSTED', fallbackEligible: true });
  }

  async callModels(models, systemPrompt, userPrompt, options = {}) {
    if (!Array.isArray(models) || !models.length) throw new Error('No Gemini models configured for the requested capability.');
    const errors = [];
    for (const model of models) {
      try { return await this.request(model, systemPrompt, userPrompt, options); }
      catch (err) {
        errors.push(`${model}: ${err.message}`);
        if (err.fallbackEligible === false) throw err;
      }
    }
    throw Object.assign(new Error(`Gemini model cascade exhausted after bounded credential rotation. ${errors.join(' | ')}`), { fallbackEligible: true, code: 'GEMINI_EXHAUSTED' });
  }

  publicTelemetry() { return this.telemetry.map((x) => ({ ...x })); }
}

module.exports = { GeminiCredentialPool, parseGeminiCredentials, extractGeminiText, retryAfterMs };
