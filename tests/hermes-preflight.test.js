const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DEFAULT_CONFIG } = require('../scripts/lib');
const { checkBasePolicyFreshness, resolveAvailableRoutes, strictFlag } = require('../scripts/hermes-preflight');

function cfg() {
  const value = structuredClone(DEFAULT_CONFIG);
  value.review.allowedExternalProviders = ['openai', 'anthropic', 'gemini'];
  value.review.routing.mode = 'auto';
  return value;
}
const flags = (overrides = {}) => ({
  HAS_OPENAI_API_KEY: 'false', HAS_ANTHROPIC_API_KEY: 'false',
  HAS_GEMINI_API_KEY: 'false', HAS_GEMINI_API_KEYS_JSON: 'false',
  HAS_OPENROUTER_API_KEY: 'false', ...overrides,
});
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ['init', '-q']);
  git(root, ['config', 'user.name', 'APES mock']);
  git(root, ['config', 'user.email', 'apes@example.test']);
  const policy = cfg();
  fs.writeFileSync(path.join(root, '.apes.json'), JSON.stringify(policy) + '\n');
  git(root, ['add', '.apes.json']);
  git(root, ['commit', '-qm', 'mock base']);
  const base = git(root, ['rev-parse', 'HEAD']);
  git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  return { root, base, policy };
}

test('Hermes preflight: OpenAI available at advanced tier with Gemini fallback', () => {
  const result = resolveAvailableRoutes(cfg(), 'advanced', flags({
    HAS_OPENAI_API_KEY: 'true', HAS_GEMINI_API_KEYS_JSON: 'true',
  }));
  assert.deepEqual(result.routes.map((x) => x.provider), ['openai', 'gemini']);
  assert.ok(result.routes.every((route) => route.models.length > 0));
});

test('Hermes preflight: Claude and OpenAI capability-ranked with Gemini fallback', () => {
  const result = resolveAvailableRoutes(cfg(), 'advanced', flags({
    HAS_OPENAI_API_KEY: 'true', HAS_ANTHROPIC_API_KEY: 'true', HAS_GEMINI_API_KEYS_JSON: 'true',
  }));
  assert.deepEqual(result.routes.map((x) => x.provider), ['anthropic', 'openai', 'gemini']);
});

test('Hermes preflight: missing direct API keys still selects Gemini', () => {
  const result = resolveAvailableRoutes(cfg(), 'advanced', flags({ HAS_GEMINI_API_KEYS_JSON: 'true' }));
  assert.deepEqual(result.routes.map((x) => x.provider), ['gemini']);
});

test('Hermes preflight: Gemini absent but approved OpenAI continues independently', () => {
  const result = resolveAvailableRoutes(cfg(), 'advanced', flags({ HAS_OPENAI_API_KEY: 'true' }));
  assert.deepEqual(result.routes.map((x) => x.provider), ['openai']);
});

test('Hermes preflight: no approved provider credentials is fail closed', () => {
  assert.throws(() => resolveAvailableRoutes(cfg(), 'advanced', flags()), /NO_ELIGIBLE_MODEL_ROUTE/);
});

test('Hermes preflight: lower-capability routes cannot silently substitute for advanced', () => {
  const config = cfg(); config.review.routing.modelCatalog.openai.advanced = [];
  config.review.allowedExternalProviders = ['openai'];
  assert.throws(() => resolveAvailableRoutes(config, 'advanced', flags({ HAS_OPENAI_API_KEY: 'true' })), /NO_ELIGIBLE_MODEL_ROUTE/);
});

test('Hermes preflight: invalid tier and malformed presence are fail closed', () => {
  assert.throws(() => resolveAvailableRoutes(cfg(), 'skip', flags({ HAS_OPENAI_API_KEY: 'true' })), /INVALID_MODEL_TIER/);
  assert.throws(() => resolveAvailableRoutes(cfg(), 'advanced', flags({ HAS_OPENAI_API_KEY: 'maybe' })), /INVALID_SECRET_PRESENCE_FLAG/);
  assert.throws(() => strictFlag(undefined, 'HAS_OPENAI_API_KEY'), /INVALID_SECRET_PRESENCE_FLAG/);
});

test('Hermes preflight: pinned event policy matching tracked main succeeds', (t) => {
  const { root, base } = repo(t);
  const result = checkBasePolicyFreshness(root, base, 'main', '.apes.json');
  assert.equal(result.policyFresh, true);
  assert.equal(result.currentBaseSha, base);
  assert.match(result.policyBlob, /^[0-9a-f]{40}$/);
});

test('Hermes preflight: updated main policy rejects stale event base SHA', (t) => {
  const { root, base, policy } = repo(t);
  policy.review.allowedExternalProviders = ['gemini'];
  fs.writeFileSync(path.join(root, '.apes.json'), JSON.stringify(policy) + '\n');
  git(root, ['add', '.apes.json']); git(root, ['commit', '-qm', 'new protected policy']);
  git(root, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'HEAD'])]);
  assert.throws(() => checkBasePolicyFreshness(root, base, 'main', '.apes.json'), /STALE_TRUSTED_POLICY/);
});

test('Hermes preflight: unrelated main commit does not invalidate unchanged policy', (t) => {
  const { root, base } = repo(t);
  fs.writeFileSync(path.join(root, 'README.md'), 'unrelated change\n');
  git(root, ['add', 'README.md']); git(root, ['commit', '-qm', 'docs only']);
  git(root, ['update-ref', 'refs/remotes/origin/main', git(root, ['rev-parse', 'HEAD'])]);
  const result = checkBasePolicyFreshness(root, base, 'main', '.apes.json');
  assert.equal(result.policyFresh, true);
  assert.notEqual(result.eventBaseSha, result.currentBaseSha);
});

test('Hermes preflight: missing remote base ref cannot permit a provider call', (t) => {
  const { root, base } = repo(t);
  assert.throws(() => checkBasePolicyFreshness(root, base, 'absent-branch', '.apes.json'), /GIT_FAILURE/);
  assert.throws(() => checkBasePolicyFreshness(root, base, '../main', '.apes.json'), /INVALID_BASE_REF/);
});

test('Hermes preflight CLI: simulated credentials only; no network or secret material', (t) => {
  const { root, base, policy } = repo(t);
  const materialized = path.join(root, 'trusted.json');
  fs.writeFileSync(materialized, JSON.stringify(policy));
  const environment = {
    ...process.env, ...flags({ HAS_OPENAI_API_KEY: 'true', HAS_GEMINI_API_KEYS_JSON: 'true' }),
    BASE_SHA: base, BASE_REF: 'main', REQUESTED_CONFIG_PATH: '.apes.json',
    PROJECT_ROOT: root, APES_CONFIG_PATH: materialized, MODEL_TIER: 'advanced',
    OPENAI_API_KEY: 'DO_NOT_PRINT_A_SECRET',
  };
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'hermes-preflight.js')], {
    env: environment, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /APES_HERMES_PREFLIGHT_VERIFIED/);
  assert.doesNotMatch(r.stdout + r.stderr, /DO_NOT_PRINT_A_SECRET/);
  assert.match(r.stdout, /"policyFresh":true/);
});
