const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ai-review.yml'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'project-repo', '.github', 'workflows', 'ai-review.yml'), 'utf8');
const assuranceWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'security-assurance.yml'), 'utf8');
const RUNTIME_SHA = '4f02a1ed79fb972998623a62c05a254e0e450687';
test('reusable workflow declares all Hermes provider secrets', () => { for (const name of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEYS_JSON']) assert.match(workflow, new RegExp(`${name}:`)); });
test('provider secrets are not passed to preflight; only credential-presence booleans are visible before model calls', () => {
  const deterministic = workflow.slice(workflow.indexOf('  deterministic-checks:'), workflow.indexOf('  provider-preflight:'));
  const preflight = workflow.slice(workflow.indexOf('  provider-preflight:'), workflow.indexOf('  ai-manifest:'));
  const manifest = workflow.slice(workflow.indexOf('  ai-manifest:'), workflow.indexOf('  ai-review-chunk:'));
  const worker = workflow.slice(workflow.indexOf('  ai-review-chunk:'), workflow.indexOf('  ai-review:'));
  const aggregate = workflow.slice(workflow.indexOf('  ai-review:'), workflow.indexOf('  quality-gate:'));
  const injectedSecrets = /^\s+(?:OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GEMINI_API_KEYS_JSON):\s+\$\{\{\s*secrets\./m;
  for (const section of [deterministic, preflight, manifest, aggregate]) {
    assert.doesNotMatch(section, injectedSecrets);
  }
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEYS_JSON', 'OPENROUTER_API_KEY']) {
    assert.ok(preflight.includes('HAS_' + key + ": ${{ secrets." + key + " != '' }}"),
      'preflight requires only the presence bit for ' + key);
    assert.ok(worker.includes(key + ': ${{ secrets.' + key + ' }}'),
      'worker can access approved credential ' + key);
  }
});
test('provider preflight verifies pinned policy before a paid review manifest is created', () => {
  const preflight = workflow.slice(workflow.indexOf('  provider-preflight:'), workflow.indexOf('  ai-manifest:'));
  const manifest = workflow.slice(workflow.indexOf('  ai-manifest:'), workflow.indexOf('  ai-review-chunk:'));
  const quality = workflow.slice(workflow.indexOf('  quality-gate:'));
  assert.match(preflight, /materialize-trusted-config\.js/);
  assert.match(preflight, /hermes-preflight\.js/);
  assert.match(preflight, /BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}/);
  assert.match(preflight, /MODEL_TIER: \$\{\{ needs\.risk-classify\.outputs\.model_tier \}\}/);
  assert.match(manifest, /needs: \[risk-classify, deterministic-checks, security-scan, provider-preflight\]/);
  assert.match(manifest, /needs\.provider-preflight\.result == 'success'/);
  assert.match(quality, /needs: \[ref-guard, risk-classify, deterministic-checks, security-scan, provider-preflight, ai-review\]/);
  assert.ok(workflow.indexOf('  provider-preflight:') < workflow.indexOf('  ai-manifest:'));
  assert.ok(workflow.indexOf('  ai-manifest:') < workflow.indexOf('  ai-review-chunk:'));
});
test('AI review security scan verifies configured runtime headers before repository assurance', () => {
  const securityScan = workflow.slice(workflow.indexOf('  security-scan:'), workflow.indexOf('  deterministic-checks:'));
  assert.match(securityScan, /verify-configured-security-headers\.js/);
  assert.match(securityScan, /APES_CONFIG_PATH: \/tmp\/apes-trusted\.json/);
  assert.ok(
    securityScan.indexOf('verify-configured-security-headers.js') < securityScan.indexOf('security-assurance-audit.js'),
    'runtime security headers should be verified before AI-review repository assurance'
  );
});
test('production caller and central default pin the reviewed runtime by exact SHA', () => { assert.match(workflow, new RegExp(`default: ${RUNTIME_SHA}`)); assert.match(template, new RegExp(`@${RUNTIME_SHA}`)); assert.match(template, new RegExp(`pipeline_ref: ${RUNTIME_SHA}`)); assert.doesNotMatch(template, /@v\d+\.\d+\.\d+/); });

test('standalone assurance workflow runs configured repository validation before scanning', () => {
  assert.match(assuranceWorkflow, /node pipeline\/scripts\/run-validation\.js/);
  assert.match(assuranceWorkflow, /node pipeline\/scripts\/audit-dependencies\.js/);
  assert.match(assuranceWorkflow, /node pipeline\/scripts\/security-assurance-audit\.js/);
  assert.ok(
    assuranceWorkflow.indexOf('run-validation.js') < assuranceWorkflow.indexOf('security-assurance-audit.js'),
    'repository validation should run before security assurance'
  );
});

test('standalone assurance workflow verifies configured runtime headers before repository assurance', () => {
  assert.match(assuranceWorkflow, /verify-configured-security-headers\.js/);
  assert.ok(
    assuranceWorkflow.indexOf('verify-configured-security-headers.js') < assuranceWorkflow.indexOf('security-assurance-audit.js'),
    'runtime security headers should be verified before repository assurance'
  );
});

test('standalone assurance resolves policy from trusted base and uses only the materialized config', () => {
  assert.match(assuranceWorkflow, /materialize-trusted-config\.js/);
  assert.match(assuranceWorkflow, /BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}/);
  assert.match(assuranceWorkflow, /APES_CONFIG_PATH: \/tmp\/apes-trusted\.json/);
  assert.doesNotMatch(assuranceWorkflow.slice(assuranceWorkflow.indexOf('Run configured repository validation')), /APES_CONFIG_PATH: \$\{\{ inputs\.config_path \}\}/);
});

test('standalone assurance has a final prerequisite gate', () => {
  assert.match(assuranceWorkflow, /enforce-assurance-prerequisites\.js/);
  assert.match(assuranceWorkflow, /VALIDATION_OUTCOME:/);
  assert.match(assuranceWorkflow, /DEPENDENCY_STEP_OUTCOME:/);
});
