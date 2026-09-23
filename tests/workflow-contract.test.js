const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ai-review.yml'), 'utf8');
const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'project-repo', '.github', 'workflows', 'ai-review.yml'), 'utf8');
const assuranceWorkflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'security-assurance.yml'), 'utf8');
const RUNTIME_SHA = '4f02a1ed79fb972998623a62c05a254e0e450687';
test('reusable workflow declares all Hermes provider secrets', () => { for (const name of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GEMINI_API_KEYS_JSON']) assert.match(workflow, new RegExp(`${name}:`)); });
test('provider secrets are passed only in the AI review section, not deterministic execution jobs', () => { const deterministic = workflow.slice(workflow.indexOf('  deterministic-checks:'), workflow.indexOf('  ai-review:')); assert.doesNotMatch(deterministic, /OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY/); const ai = workflow.slice(workflow.indexOf('  ai-review:'), workflow.indexOf('  quality-gate:')); assert.match(ai, /OPENAI_API_KEY/); assert.match(ai, /ANTHROPIC_API_KEY/); assert.match(ai, /GEMINI_API_KEYS_JSON/); });
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
