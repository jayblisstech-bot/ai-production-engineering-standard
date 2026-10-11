#!/usr/bin/env node
/**
 * No-provider-call Hermes preflight.
 *
 * The review event's BASE_SHA can remain pinned to an older main commit even
 * after main's trusted .apes.json has changed. Reject differing trusted-policy
 * blobs before scheduling any paid chunk, rather than silently using Gemini.
 *
 * Only boolean secret-presence flags enter this script. Never materialize,
 * print, or send actual provider credentials here.
 */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadConfig } = require('./lib');
const { providerOrderForCapability, modelCandidates } = require('./hermes-orchestrator');

const TIERS = new Set(['medium', 'strong', 'advanced']);

function git(projectRoot, args, optional = false) {
  const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0 || result.error) {
    if (optional) return null;
    throw new Error('APES_HERMES_PREFLIGHT_GIT_FAILURE: could not resolve trusted base-branch ref');
  }
  return result.stdout.trim();
}

function checkBasePolicyFreshness(projectRoot, baseSha, baseRef, configPath) {
  if (!/^[0-9a-f]{40}$/.test(baseSha || '')) throw new Error('APES_HERMES_PREFLIGHT_INVALID_BASE_SHA');
  if (!baseRef || !/^[A-Za-z0-9._/-]+$/.test(baseRef) || baseRef.includes('..') ||
      baseRef.includes('//') || baseRef.startsWith('/') || baseRef.endsWith('/') ||
      baseRef.startsWith('-') || baseRef.includes('@{')) {
    throw new Error('APES_HERMES_PREFLIGHT_INVALID_BASE_REF');
  }
  if (!configPath || path.isAbsolute(configPath) ||
      configPath.split('/').some((s) => !s || s === '.' || s === '..') ||
      configPath.includes(':') || configPath.includes('\\')) {
    throw new Error('APES_HERMES_PREFLIGHT_INVALID_CONFIG_PATH');
  }
  const remoteRef = 'refs/remotes/origin/' + baseRef;
  const currentBaseSha = git(projectRoot, ['rev-parse', '--verify', remoteRef + '^{commit}']);
  if (!/^[0-9a-f]{40}$/.test(currentBaseSha)) throw new Error('APES_HERMES_PREFLIGHT_INVALID_TRACKED_BASE');
  const eventBlob = git(projectRoot, ['rev-parse', baseSha + ':' + configPath], true);
  const currentBlob = git(projectRoot, ['rev-parse', currentBaseSha + ':' + configPath], true);
  if (eventBlob !== currentBlob) {
    throw new Error('APES_HERMES_PREFLIGHT_STALE_TRUSTED_POLICY: pull-request event base policy differs from tracked base branch. Refresh the PR base integration before spending on AI review.');
  }
  return { eventBaseSha: baseSha, currentBaseSha, policyBlob: eventBlob, policyFresh: true };
}

function strictFlag(value, name) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('APES_HERMES_PREFLIGHT_INVALID_SECRET_PRESENCE_FLAG: ' + name);
}

function resolveAvailableRoutes(config, modelTier, env) {
  if (!TIERS.has(modelTier)) throw new Error('APES_HERMES_PREFLIGHT_INVALID_MODEL_TIER');
  const present = {
    openai: strictFlag(env.HAS_OPENAI_API_KEY, 'HAS_OPENAI_API_KEY'),
    anthropic: strictFlag(env.HAS_ANTHROPIC_API_KEY, 'HAS_ANTHROPIC_API_KEY'),
    openrouter: strictFlag(env.HAS_OPENROUTER_API_KEY, 'HAS_OPENROUTER_API_KEY'),
    gemini: strictFlag(env.HAS_GEMINI_API_KEY, 'HAS_GEMINI_API_KEY') ||
      strictFlag(env.HAS_GEMINI_API_KEYS_JSON, 'HAS_GEMINI_API_KEYS_JSON'),
  };
  // Synthetic flags are enough for Hermes' deterministic route computation.
  // None of these are real API keys or leave the runner.
  const simulatedCredentials = {
    OPENAI_API_KEY: present.openai ? 'available' : '',
    ANTHROPIC_API_KEY: present.anthropic ? 'available' : '',
    OPENROUTER_API_KEY: present.openrouter ? 'available' : '',
    GEMINI_API_KEY: present.gemini ? 'available' : '',
  };
  const ordered = providerOrderForCapability(config, modelTier, simulatedCredentials);
  const routes = ordered.map((provider) => ({ provider, models: modelCandidates(config, provider, modelTier) }));
  if (routes.length === 0 || routes.some((x) => x.models.length === 0 ||
      x.models.some((model) => typeof model !== 'string' || !model.trim()))) {
    throw new Error('APES_HERMES_PREFLIGHT_NO_ELIGIBLE_MODEL_ROUTE: no permitted configured model at required capability with available credentials');
  }
  return { modelTier, allowedProviders: config.review.allowedExternalProviders,
    credentialPresence: present, routes };
}

function main() {
  const env = process.env;
  const projectRoot = path.resolve(env.PROJECT_ROOT || process.cwd());
  const freshness = checkBasePolicyFreshness(projectRoot, env.BASE_SHA, env.BASE_REF, env.REQUESTED_CONFIG_PATH || '.apes.json');
  const config = loadConfig(projectRoot, env.APES_CONFIG_PATH);
  const eligible = resolveAvailableRoutes(config, env.MODEL_TIER, env);
  console.log('APES_HERMES_PREFLIGHT_VERIFIED ' + JSON.stringify({ ...freshness, ...eligible }));
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { checkBasePolicyFreshness, resolveAvailableRoutes, strictFlag, main };
