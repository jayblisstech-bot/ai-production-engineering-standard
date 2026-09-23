const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../scripts/lib');
function withConfig(obj, fn) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-config-')); fs.writeFileSync(path.join(root, '.apes.json'), JSON.stringify(obj, null, 2)); try { return fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); } }
test('valid partial config merges with defaults', () => { withConfig({ version: 1, security: { dependencyAudit: 'required' } }, (root) => { const cfg = loadConfig(root); assert.equal(cfg.security.dependencyAudit, 'required'); assert.deepEqual(cfg.runtime.requiredScripts, ['typecheck', 'test', 'build']); }); });
test('unknown top-level keys fail loudly', () => { withConfig({ version: 1, externalAI: { allowed: true } }, (root) => { assert.throws(() => loadConfig(root), /Unknown APES config key: externalAI/); }); });
test('unknown nested keys fail loudly', () => { withConfig({ version: 1, review: { approvedProviders: ['openrouter'] } }, (root) => { assert.throws(() => loadConfig(root), /Unknown APES config key: review\.approvedProviders/); }); });
test('wrong config value shapes fail loudly', () => { withConfig({ version: 1, runtime: { requiredScripts: 'test' } }, (root) => { assert.throws(() => loadConfig(root), /runtime\.requiredScripts must be an array/); }); });
test('unsupported provider names fail loudly', () => { withConfig({ version: 1, review: { allowedExternalProviders: ['unknown-provider'] } }, (root) => { assert.throws(() => loadConfig(root), /Unsupported external AI provider/); }); });
test('invalid dependency-audit mode fails loudly', () => { withConfig({ version: 1, security: { dependencyAudit: 'sometimes' } }, (root) => { assert.throws(() => loadConfig(root), /Invalid security\.dependencyAudit mode/); }); });
test('unsafe review limits fail loudly', () => { withConfig({ version: 1, review: { maxChunks: 0 } }, (root) => { assert.throws(() => loadConfig(root), /review\.maxChunks must be an integer/); }); });
test('direct OpenAI/Anthropic provider names are accepted', () => { withConfig({ version: 1, review: { allowedExternalProviders: ['openai', 'anthropic', 'gemini'] } }, (root) => { const cfg = loadConfig(root); assert.deepEqual(cfg.review.allowedExternalProviders, ['openai', 'anthropic', 'gemini']); }); });
test('invalid Hermes routing mode fails loudly', () => { withConfig({ version: 1, review: { routing: { mode: 'magic' } } }, (root) => { assert.throws(() => loadConfig(root), /Invalid review\.routing\.mode/); }); });
test('invalid capability provider preference fails loudly', () => { withConfig({ version: 1, review: { routing: { providerPreference: { medium: ['unknown'] } } } }, (root) => { assert.throws(() => loadConfig(root), /providerPreference\.medium/); }); });

test('security assurance audit mode is accepted', () => { withConfig({ version: 1, security: { assurance: { mode: 'audit' } } }, (root) => { const cfg = loadConfig(root); assert.equal(cfg.security.assurance.mode, 'audit'); }); });
test('invalid security assurance mode fails loudly', () => { withConfig({ version: 1, security: { assurance: { mode: 'magic' } } }, (root) => { assert.throws(() => loadConfig(root), /Invalid security\.assurance\.mode/); }); });
test('monorepo runtime projects are accepted', () => { withConfig({ version: 1, runtime: { projects: [{ path: 'backend', requiredScripts: ['build'], optionalScripts: [] }] } }, (root) => { const cfg = loadConfig(root); assert.equal(cfg.runtime.projects[0].path, 'backend'); }); });
test('unsafe monorepo project paths fail', () => { withConfig({ version: 1, runtime: { projects: [{ path: '../outside' }] } }, (root) => { assert.throws(() => loadConfig(root), /safe relative path/); }); });

test('security header policy defaults to required', () => { withConfig({ version: 1 }, (root) => { const cfg = loadConfig(root); assert.equal(cfg.security.headers.mode, 'required'); }); });
test('invalid security header mode fails loudly', () => { withConfig({ version: 1, security: { headers: { mode: 'magic' } } }, (root) => { assert.throws(() => loadConfig(root), /Invalid security\.headers\.mode/); }); });
test('invalid security header applicability fails loudly', () => { withConfig({ version: 1, security: { headers: { applicability: 'maybe' } } }, (root) => { assert.throws(() => loadConfig(root), /Invalid security\.headers\.applicability/); }); });
test('unsupported required security header fails loudly', () => { withConfig({ version: 1, security: { headers: { required: ['x-made-up-header'] } } }, (root) => { assert.throws(() => loadConfig(root), /Unsupported security\.headers\.required/); }); });
