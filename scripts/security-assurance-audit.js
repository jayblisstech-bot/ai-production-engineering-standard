#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { loadConfig, assertSafeProjectPath, isProbablyText, matchesAny } = require('./lib');
const { detectSecretsInText } = require('./scan-secrets');

const LAYERS = [
  [1, 'Identity & Session Security'],
  [2, 'Authorization & Tenant Isolation'],
  [3, 'Application, API & Client Security'],
  [4, 'Data Protection, Privacy & Residency'],
  [5, 'Database, Financial & Transaction Integrity'],
  [6, 'Integrations, Webhooks & External APIs'],
  [7, 'Dependencies & Software Supply Chain'],
  [8, 'Infrastructure, Hosting & Network Security'],
  [9, 'CI/CD & Release Security'],
  [10, 'Logging, Monitoring, Detection & Auditability'],
  [11, 'Availability, Performance & Resilience'],
  [12, 'Backup, Disaster Recovery & Incident Response'],
  [13, 'AI/LLM Security & Governance'],
];

const EXCLUDED_DIRS = new Set(['.git','node_modules','dist','build','coverage','.next','.turbo','vendor','target','.cache']);

const SENSITIVE_ARTIFACT_RULES = [
  { re: /\.(?:pem|key|p12|pfx)$/i, severity: 'P0', message: 'Key/certificate container committed to the repository requires immediate verification; private key material must not be stored in source control.' },
  { re: /\.(?:sql|dump|sqlite|sqlite3|db|bak|backup)$/i, severity: 'P1', message: 'Database backup/dump artifact is committed to the repository. Verify it contains no production/customer data or credentials and remove sensitive backups from source control.' },
  { re: /\.(?:zip|tar|tgz|gz|7z)$/i, severity: 'P2', message: 'Archive artifact is committed to the repository. Verify it does not contain generated binaries, secrets, customer data, or excluded files.' },
];

function findSensitiveArtifacts(root, maxFiles = 20000) {
  const results = [];
  function visit(dir) {
    if (results.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (results.length >= maxFiles) break;
      if (entry.isDirectory() && (EXCLUDED_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github'))) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const normalized = full.replace(/\\/g, '/');
      if (/\/migrations\//i.test(normalized) && /\.sql$/i.test(normalized)) continue;
      const rule = SENSITIVE_ARTIFACT_RULES.find((r) => r.re.test(entry.name));
      if (!rule) continue;
      const stat = fs.statSync(full);
      results.push({ full, severity: rule.severity, message: rule.message, size: stat.size });
    }
  }
  visit(root);
  return results;
}

const RULES = [
  {
    id: 'AUTH_SECRET_FALLBACK', layer: 1, severity: 'P1',
    filePredicate: (text) => {
      const fallback = /(?:AUTH_SECRET|JWT_SECRET|SESSION_SECRET|rawSecret)\s*[^\n]{0,120}\|\|\s*['"][^'"]{8,}['"]/i.test(text);
      if (!fallback) return false;
      const explicitTestOnlyFailClosed =
        /NODE_ENV\s*!==\s*['"]test['"]/i.test(text) &&
        /process\.exit\s*\(\s*1\s*\)/i.test(text) &&
        /test[-_ ]only|do-not-use-in-production/i.test(text);
      return !explicitTestOnlyFailClosed;
    },
    message: 'Authentication/session signing secret appears to have a hard-coded fallback without a verified test-only fail-closed guard.'
  },
  {
    id: 'BROWSER_TOKEN_STORAGE', layer: 1, severity: 'P1',
    re: /localStorage\.(?:setItem|getItem)\s*\(\s*['"][^'"]*(?:token|jwt|session)[^'"]*['"]/i,
    message: 'Sensitive authentication token appears to be stored/read from browser localStorage, increasing XSS credential-theft impact.'
  },
  {
    id: 'RAW_UNSAFE_QUERY_DYNAMIC', layer: 3, severity: 'P0',
    re: /\$(?:queryRawUnsafe|executeRawUnsafe)\s*\(\s*(?:`[^`]*\$\{|[^)\n]*(?:req\.|request\.|params\.|body\.|query\.|userInput|user_input|input)[^)\n]*)/i,
    message: 'Potentially dynamic unsafe raw database execution was detected. Treat as injection-critical until proven otherwise.'
  },
  {
    id: 'RAW_UNSAFE_QUERY', layer: 3, severity: 'P2',
    re: /\$(?:queryRawUnsafe|executeRawUnsafe)\s*\(/i,
    message: 'Unsafe raw database API usage was detected. Verify the SQL is static or parameterized; prefer safe tagged/parameterized APIs.'
  },
  {
    id: 'TLS_VERIFICATION_DISABLED', layer: 8, severity: 'P0',
    re: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|rejectUnauthorized\s*:\s*false/i,
    message: 'TLS certificate verification appears disabled.'
  },
  {
    id: 'DANGEROUS_HTML', layer: 3, severity: 'P2',
    re: /dangerouslySetInnerHTML/i,
    message: 'Raw HTML rendering was detected. Verify dedicated sanitization and a documented requirement.'
  },
  {
    id: 'CREDENTIALED_CORS_FAIL_OPEN', layer: 3, severity: 'P1',
    filePredicate: (text) => /cors\s*\(/i.test(text) && /credentials\s*:\s*true/i.test(text) &&
      (/origin\s*:\s*['"]\*['"]/i.test(text) || /else\s*\{[^}]{0,250}callback\s*\(\s*null\s*,\s*true\s*\)/is.test(text)),
    message: 'Credentialed CORS appears wildcarded or fail-open for unapproved origins.'
  },
  {
    id: 'WEBHOOK_OPTIONAL_SIGNATURE', layer: 6, severity: 'P1',
    re: /if\s*\(\s*\w*(?:webhook)?Secret\w*\s*&&\s*\w*signature\w*\s*\)/i,
    message: 'Webhook signature verification appears conditional on both secret and signature being present; missing verification material may bypass authentication.'
  },
  {
    id: 'WEBHOOK_SECRET_OPTIONAL', layer: 6, severity: 'P1',
    filePredicate: (text) => {
      const readsWebhookSecret = /process\.env\.[A-Z0-9_]*WEBHOOK_SECRET/i.test(text);
      const conditionalVerification = /if\s*\(\s*\w*(?:webhook)?Secret\w*\s*\)\s*\{/i.test(text);
      const explicitMissingSecretRejection =
        /if\s*\(\s*!\s*\w*(?:webhook)?Secret\w*\s*\)[\s\S]{0,400}(?:return|throw|process\.exit)/i.test(text);
      return readsWebhookSecret && conditionalVerification && !explicitMissingSecretRejection;
    },
    message: 'Webhook verification secret appears optional; when the secret is absent the endpoint may accept unsigned events. Production webhook verification must fail closed.'
  },
  {
    id: 'PUBLIC_UPLOAD_STATIC', layer: 3, severity: 'P2',
    re: /express\.static\([^\n]*(?:uploads|upload)/i,
    message: 'Upload storage appears directly exposed via static serving. Verify private ACLs, randomized names, content validation, and non-executable storage.'
  },
  {
    id: 'HARDCODED_PRIVATE_KEY', layer: 4, severity: 'P0',
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    message: 'Private key material appears embedded in source.'
  }
];

const EVIDENCE_PATTERNS = {
  1: [/bcrypt|argon2|jwt|session|httpOnly|sameSite/i],
  2: [/rbac|authoriz|permission|tenant|companyMember|ownership/i],
  3: [/zod|joi|validator|csrf|cors|rate.?limit|multer|sanitize/i],
  4: [/encrypt|tls|https|retention|privacy|residency|subprocessor/i],
  5: [/transaction|decimal|reconcil|migration|idempot|rollback/i],
  6: [/webhook|signature|hmac|retry|idempot|external api/i],
  7: [/package-lock|pnpm-lock|yarn.lock|dependabot|codeql|secret scan|sbom/i],
  8: [/nginx|docker|firewall|security group|ssh|kubernetes|terraform|hosting/i],
  9: [/github\/workflows|deploy|staging|production|rollback|artifact/i],
  10: [/monitor|alert|audit log|observability|sentry|prometheus|logging/i],
  11: [/timeout|retry|circuit|backpressure|pagination|rate.?limit|index/i],
  12: [/backup|restore|incident|disaster|rpo|rto|business continuity/i],
  13: [/openai|anthropic|gemini|llm|prompt injection|ai governance|model/i],
};

const SECURITY_HEADER_LABELS = {
  'content-security-policy': 'Content-Security-Policy',
  'strict-transport-security': 'Strict-Transport-Security',
  'x-content-type-options': 'X-Content-Type-Options: nosniff',
  'referrer-policy': 'Referrer-Policy',
  'permissions-policy': 'Permissions-Policy',
  'frame-protection': 'frame protection (CSP frame-ancestors or X-Frame-Options)',
};

const WEB_APP_PATTERNS = [
  /\bexpress\s*\(/i,
  /\bfastify\s*\(/i,
  /NestFactory\./i,
  /\bkoa\s*\(/i,
  /createServer\s*\(/i,
  /\bnext\s*\(/i,
  /"express"\s*:/i,
  /"fastify"\s*:/i,
  /"@nestjs\//i,
  /"next"\s*:/i,
  /"react"\s*:/i,
  /"vue"\s*:/i,
  /"@angular\//i,
];

function isWebApplication(runtimeFiles, headerConfig) {
  if (headerConfig.applicability === 'web') return true;
  if (headerConfig.applicability === 'non-web') return false;
  return runtimeFiles.some(({ text }) => WEB_APP_PATTERNS.some((re) => re.test(text)));
}

function hasHeaderEvidence(name, runtimeFiles) {
  const combined = runtimeFiles.map(({ text }) => text).join('\n');
  const helmetUsed = /\bhelmet\s*\(\s*\)|\bhelmet\s*\(\s*\{|register\s*\(\s*helmet\b/i.test(combined);
  const helmetCspDisabled = /contentSecurityPolicy\s*:\s*false/i.test(combined);
  const helmetHstsDisabled = /\bhsts\s*:\s*false/i.test(combined);

  if (name === 'content-security-policy') {
    return (helmetUsed && !helmetCspDisabled) || /Content-Security-Policy/i.test(combined);
  }
  if (name === 'strict-transport-security') {
    return (helmetUsed && !helmetHstsDisabled) || /Strict-Transport-Security/i.test(combined);
  }
  if (name === 'x-content-type-options') {
    return helmetUsed || (/X-Content-Type-Options/i.test(combined) && /nosniff/i.test(combined));
  }
  if (name === 'referrer-policy') {
    return helmetUsed || /Referrer-Policy/i.test(combined);
  }
  if (name === 'permissions-policy') {
    return /Permissions-Policy/i.test(combined);
  }
  if (name === 'frame-protection') {
    return helmetUsed || /X-Frame-Options/i.test(combined) || /frame-ancestors/i.test(combined);
  }
  return false;
}

function analyzeSecurityHeaders(runtimeFiles, headerConfig, runtimeVerified = false) {
  if (!headerConfig || headerConfig.mode === 'off') {
    return { applicable: false, mode: 'off', missing: [], present: [], evidenceFiles: [] };
  }
  const applicable = isWebApplication(runtimeFiles, headerConfig);
  if (!applicable) {
    return { applicable: false, mode: headerConfig.mode, missing: [], present: [], evidenceFiles: [] };
  }

  const headerVerifierPatterns = [
    '**/scripts/verify-security-headers.*',
    '**/scripts/check-security-headers.*',
    '**/scripts/security-headers.*',
    '**/security-headers.test.*',
    '**/security-headers.spec.*',
    '**/verify-security-headers.*',
    '**/check-security-headers.*'
  ];
  const evidenceCandidates = runtimeFiles.filter(({ path }) => !matchesAny(path, headerVerifierPatterns));
  const required = headerConfig.required || [];
  const staticPresent = required.filter((name) => hasHeaderEvidence(name, evidenceCandidates));
  const present = runtimeVerified ? [...required] : staticPresent;
  const missing = runtimeVerified ? [] : required.filter((name) => !staticPresent.includes(name));
  const evidenceFiles = evidenceCandidates
    .filter(({ text }) => /Content-Security-Policy|Strict-Transport-Security|X-Content-Type-Options|Referrer-Policy|Permissions-Policy|X-Frame-Options|frame-ancestors|\bhelmet\b/i.test(text))
    .map(({ path }) => path)
    .slice(0, 12);

  return { applicable: true, mode: headerConfig.mode, required, present, missing, evidenceFiles, runtimeVerified };
}

function walk(root, maxFiles, maxFileBytes) {
  const files = [];
  function visit(dir) {
    if (files.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory() && (EXCLUDED_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github'))) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        if (stat.size <= maxFileBytes) files.push(full);
      }
    }
  }
  visit(root);
  return files;
}

function lineNumber(text, index) {
  return text.slice(0, Math.max(0, index)).split('\n').length;
}

function scanRepository(projectRoot, config) {
  const assurance = config.security.assurance;
  const roots = assurance.scanRoots.map((r) => assertSafeProjectPath(projectRoot, r));
  const seen = new Set();
  const findings = [];
  const layerEvidence = new Map(LAYERS.map(([n]) => [n, new Set()]));

  const sensitiveSeen = new Set();
  for (const root of roots) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
    for (const artifact of findSensitiveArtifacts(root, assurance.maxFiles)) {
      const normalized = path.relative(projectRoot, artifact.full).replace(/\\/g, '/');
      if (sensitiveSeen.has(normalized)) continue;
      sensitiveSeen.add(normalized);
      findings.push({
        id: 'SENSITIVE_REPOSITORY_ARTIFACT',
        layer: 4,
        severity: artifact.severity,
        path: normalized,
        line: 1,
        message: artifact.message + ' Size: ' + artifact.size + ' bytes.',
      });
    }
  }
  const runtimeFiles = [];
  let scannedFiles = 0;

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const candidates = fs.statSync(root).isDirectory() ? walk(root, assurance.maxFiles, assurance.maxFileBytes) : [root];
    for (const full of candidates) {
      const normalized = path.relative(projectRoot, full).replace(/\\/g, '/');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const buf = fs.readFileSync(full);
      if (!isProbablyText(buf)) continue;
      scannedFiles += 1;
      const text = buf.toString('utf8');

      for (const secret of detectSecretsInText(text, normalized)) {
        const testOrExamplePath = matchesAny(normalized, [
          '**/*.test.*', '**/*.spec.*', 'tests/**', 'test/**', 'fixtures/**',
          '**/scripts/test-*', '**/scripts/*test*', '**/scripts/*audit*', '**/scripts/*acceptance*', '**/scripts/*probe*', '**/.env.example', '**/*.example'
        ]);
        const highConfidenceSecret = new Set([
          'private-key', 'github-token', 'openai-openrouter-key', 'anthropic-key',
          'google-api-key', 'aws-access-key', 'stripe-live-secret', 'stripe-webhook-secret'
        ]).has(secret.type);
        const severity = highConfidenceSecret
          ? 'P0'
          : testOrExamplePath
          ? 'P2'
          : secret.type === 'credential-url'
          ? 'P0'
          : 'P1';
        findings.push({
          id: 'REPOSITORY_SECRET_EXPOSURE',
          layer: 4,
          severity,
          path: normalized,
          line: secret.line,
          message: 'Potential repository credential exposure detected (' + secret.type + '). Remove real credentials from the current tree; rotate and review repository history if the value was ever live. Test/example values require verification rather than automatic credential-rotation assumptions.',
        });
      }

      for (const [layer, patterns] of Object.entries(EVIDENCE_PATTERNS)) {
        if (patterns.some((re) => re.test(normalized) || re.test(text))) layerEvidence.get(Number(layer)).add(normalized);
      }

      const excludedFromCodeRules = matchesAny(normalized, assurance.excludePaths || []);
      if (!excludedFromCodeRules) runtimeFiles.push({ path: normalized, text });
      for (const rule of RULES) {
        if (excludedFromCodeRules && rule.id !== 'HARDCODED_PRIVATE_KEY') continue;
        let matched = null;
        if (rule.re) matched = rule.re.exec(text);
        else if (rule.filePredicate && rule.filePredicate(text, normalized)) matched = { index: 0 };
        if (!matched) continue;
        findings.push({
          id: rule.id,
          layer: rule.layer,
          severity: rule.severity,
          path: normalized,
          line: lineNumber(text, matched.index || 0),
          message: rule.message,
        });
      }
    }
  }

  const runtimeHeadersVerified = process.env.APES_RUNTIME_HEADERS_VERIFIED === '1';
  const securityHeaders = analyzeSecurityHeaders(runtimeFiles, config.security.headers, runtimeHeadersVerified);
  if (securityHeaders.applicable && securityHeaders.missing.length) {
    findings.push({
      id: 'SECURITY_HEADERS_INCOMPLETE',
      layer: 3,
      severity: 'P1',
      policy: 'security-headers',
      path: '<repository>',
      line: 1,
      message: 'Production web security header baseline is incomplete. Missing: ' + securityHeaders.missing.map((name) => SECURITY_HEADER_LABELS[name] || name).join(', ') + '.',
    });
  }

  const evidenceRoot = assertSafeProjectPath(projectRoot, assurance.evidenceRoot);
  const expectedEvidence = [
    'SECURITY_POLICY.md','SECURITY_ARCHITECTURE.md','DATA_HANDLING.md','DATA_RESIDENCY.md',
    'ENCRYPTION_STANDARD.md','ACCESS_CONTROL.md','VULNERABILITY_MANAGEMENT.md','INCIDENT_RESPONSE.md',
    'BACKUP_AND_RECOVERY.md','BUSINESS_CONTINUITY.md','SUBPROCESSORS.md','AI_DATA_GOVERNANCE.md',
    'PENETRATION_TEST_SUMMARY.md','SECURITY_ASSURANCE_REPORT.md'
  ];
  const evidenceFiles = expectedEvidence.filter((name) => fs.existsSync(path.join(evidenceRoot, name)));
  const statuses = {};
  for (const [num, name] of LAYERS) {
    const layerFindings = findings.filter((f) => f.layer === num);
    const blocking = layerFindings.some((f) => f.severity === 'P0' || f.severity === 'P1');
    const evidence = [...layerEvidence.get(num)].slice(0, 12);
    statuses[num] = {
      name,
      status: blocking ? 'FAIL' : (layerFindings.length || evidence.length ? 'PARTIAL' : 'UNKNOWN'),
      evidence,
      findings: layerFindings,
    };
  }
  return { scannedFiles, findings, statuses, evidenceFiles, expectedEvidence, securityHeaders };
}

function toMarkdown(result, config) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  result.findings.forEach((f) => counts[f.severity]++);
  const lines = [
    '# APES 13-Layer Production Security Assurance Audit',
    '',
    '> Static repository audit. This is not an independent penetration test and does not verify live infrastructure unless authoritative evidence is present in the repository.',
    '',
    'Mode: **' + config.security.assurance.mode + '**',
    'Files scanned: **' + result.scannedFiles + '**',
    'Findings: **P0 ' + counts.P0 + ' / P1 ' + counts.P1 + ' / P2 ' + counts.P2 + ' / P3 ' + counts.P3 + '**',
    '',
    '## Executive findings',
    ''
  ];
  if (!result.findings.length) lines.push('No deterministic anti-pattern findings were detected. This does **not** mean all 13 layers are verified.');
  for (const f of result.findings) lines.push('- **' + f.severity + ' ' + f.id + '** — ' + f.path + ':' + f.line + ': ' + f.message);
  lines.push('', '## 13-layer assurance', '');
  for (const [num, name] of LAYERS) {
    const item = result.statuses[num];
    lines.push('### Layer ' + num + ' — ' + name, '', '**Status: ' + item.status + '**', '', 'Verified repository evidence:');
    if (item.evidence.length) item.evidence.forEach((e) => lines.push('- ' + e));
    else lines.push('- None verified from the scanned repository.');
    lines.push('', 'Findings:');
    if (item.findings.length) item.findings.forEach((f) => lines.push('- **' + f.severity + '** ' + f.message + ' (' + f.path + ':' + f.line + ')'));
    else lines.push('- No deterministic finding for this layer. Controls may still be unknown or require live/operational verification.');
    lines.push('');
  }
  lines.push('## Security header baseline', '');
  if (!result.securityHeaders || !result.securityHeaders.applicable) {
    lines.push('Applicability: **not detected / explicitly non-web**', '');
  } else {
    lines.push('Policy mode: **' + result.securityHeaders.mode + '**');
    lines.push('Present: ' + (result.securityHeaders.present.length ? result.securityHeaders.present.map((name) => SECURITY_HEADER_LABELS[name] || name).join(', ') : 'none'));
    lines.push('Missing: ' + (result.securityHeaders.missing.length ? result.securityHeaders.missing.map((name) => SECURITY_HEADER_LABELS[name] || name).join(', ') : 'none'));
    if (result.securityHeaders.runtimeVerified) lines.push('Runtime verification: **PASS**');
    if (result.securityHeaders.evidenceFiles.length) lines.push('Repository evidence files: ' + result.securityHeaders.evidenceFiles.join(', '));
    lines.push('');
  }

  lines.push('## Enterprise security evidence pack', '', 'Evidence directory: ' + config.security.assurance.evidenceRoot, '');
  for (const name of result.expectedEvidence) lines.push('- [' + (result.evidenceFiles.includes(name) ? 'x' : ' ') + '] ' + name);
  lines.push('', '## Required interpretation', '',
    '- FAIL means a deterministic blocking anti-pattern was detected in that layer.',
    '- PARTIAL means repository evidence exists and/or a non-blocking finding exists, but APES has not verified the entire control layer.',
    '- UNKNOWN means APES cannot verify the layer from available repository evidence.',
    '- A clean internal audit is not an external penetration test.',
    '- Infrastructure, encryption-at-rest, backups, restore testing, residency, monitoring, and incident-response claims require authoritative operational evidence.',
    ''
  );
  return lines.join('\n');
}

function evaluateAssurance(result, config) {
  const failing = new Set(config.security.assurance.failOnSeverities);
  const blocking = result.findings.filter((f) => failing.has(f.severity));
  const headerBlocking = blocking.filter((f) => f.policy === 'security-headers');
  const assuranceBlocking = blocking.filter((f) => f.policy !== 'security-headers');
  const shouldFail =
    (config.security.assurance.mode === 'enforce' && assuranceBlocking.length > 0) ||
    (config.security.headers.mode === 'required' && headerBlocking.length > 0);
  return { blocking, headerBlocking, assuranceBlocking, shouldFail };
}

function main() {
  const projectRoot = path.resolve(process.env.PROJECT_ROOT || process.cwd());
  const config = loadConfig(projectRoot, process.env.APES_CONFIG_PATH || '.apes.json');
  const assurance = config.security.assurance;
  if (assurance.mode === 'off') {
    console.log('APES 13-layer security assurance scan is disabled.');
    return;
  }
  const result = scanRepository(projectRoot, config);
  const markdown = toMarkdown(result, config);
  const output = process.env.APES_AUDIT_OUTPUT || path.join(projectRoot, 'AI_ENGINEERING_AUDIT.generated.md');
  fs.writeFileSync(output, markdown);
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + '\n');

  const enforcement = evaluateAssurance(result, config);
  if (enforcement.shouldFail) {
    console.error('APES security assurance FAILED CLOSED with ' + enforcement.blocking.length + ' configured blocking finding(s).');
    if (enforcement.headerBlocking.length) console.error('Required production security headers are incomplete.');
    process.exit(1);
  }
  if (assurance.mode === 'audit' && enforcement.blocking.length) {
    console.warn('AUDIT MODE: ' + enforcement.blocking.length + ' blocking-severity finding(s) recorded without failing the workflow. Remediate before switching assurance.mode to enforce.');
  }
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.stack || err.message); process.exit(1); }
}
module.exports = { LAYERS, RULES, SECURITY_HEADER_LABELS, SENSITIVE_ARTIFACT_RULES, findSensitiveArtifacts, isWebApplication, analyzeSecurityHeaders, walk, scanRepository, toMarkdown, evaluateAssurance };
