const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DEFAULT_CONFIG } = require('../scripts/lib');
const { scanRepository, toMarkdown, LAYERS, analyzeSecurityHeaders } = require('../scripts/security-assurance-audit');

function tempRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-assurance-'));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

function cfg(mode = 'audit') {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.security.assurance.mode = mode;
  return config;
}

test('defines exactly 13 assurance layers', () => {
  assert.equal(LAYERS.length, 13);
});

test('detects browser localStorage authentication token storage', () => {
  const root = tempRepo({ 'frontend/auth.ts': "localStorage.setItem('numerra_token', token);" });
  try {
    const result = scanRepository(root, cfg());
    assert.ok(result.findings.some((f) => f.id === 'BROWSER_TOKEN_STORAGE' && f.severity === 'P1'));
    assert.equal(result.statuses[1].status, 'FAIL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detects optional webhook signature verification', () => {
  const root = tempRepo({ 'src/webhook.ts': "if (webhookSecret && signature) { verify(signature); }" });
  try {
    const result = scanRepository(root, cfg());
    assert.ok(result.findings.some((f) => f.id === 'WEBHOOK_OPTIONAL_SIGNATURE'));
    assert.equal(result.statuses[6].status, 'FAIL');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detects credentialed CORS fail-open branch', () => {
  const root = tempRepo({ 'src/server.ts': "app.use(cors({ credentials: true, origin(origin, callback) { if (ok(origin)) callback(null,true); else { callback(null, true); } } }));" });
  try {
    const result = scanRepository(root, cfg());
    assert.ok(result.findings.some((f) => f.id === 'CREDENTIALED_CORS_FAIL_OPEN'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('never manufactures PASS solely from repository heuristics', () => {
  const root = tempRepo({ 'src/index.ts': 'export const x = 1;' });
  try {
    const result = scanRepository(root, cfg());
    for (const layer of Object.values(result.statuses)) assert.notEqual(layer.status, 'PASS');
    assert.match(toMarkdown(result, cfg()), /not an independent penetration test/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('required security headers are detected from Helmet plus explicit Permissions-Policy', () => {
  const files = [{ path: 'src/server.js', text: "app.use(helmet()); app.use((req,res,next)=>{ res.setHeader('Permissions-Policy','camera=(), microphone=()'); next(); });" }];
  const result = analyzeSecurityHeaders(files, {
    mode: 'required',
    applicability: 'web',
    required: ['content-security-policy','strict-transport-security','x-content-type-options','referrer-policy','permissions-policy','frame-protection']
  });
  assert.deepEqual(result.missing, []);
});

test('web application missing header baseline produces blocking P1 finding', () => {
  const root = tempRepo({ 'package.json': JSON.stringify({ dependencies: { express: '^5.0.0' } }), 'src/server.js': "const express=require('express'); const app=express();" });
  try {
    const config = cfg('audit');
    config.security.headers.mode = 'required';
    config.security.headers.applicability = 'web';
    const result = scanRepository(root, config);
    const finding = result.findings.find((f) => f.id === 'SECURITY_HEADERS_INCOMPLETE');
    assert.equal(finding.severity, 'P1');
    assert.ok(result.securityHeaders.missing.includes('content-security-policy'));
    assert.ok(result.securityHeaders.missing.includes('permissions-policy'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('security-header verifier script alone cannot satisfy implementation evidence', () => {
  const files = [
    {
      path: 'backend/scripts/verify-security-headers.ts',
      text: "fetch(url); headers.get('content-security-policy'); headers.get('strict-transport-security'); headers.get('x-content-type-options'); headers.get('referrer-policy'); headers.get('permissions-policy'); headers.get('x-frame-options');"
    },
    {
      path: 'backend/src/index.ts',
      text: "const express = require('express'); const app = express();"
    }
  ];
  const result = analyzeSecurityHeaders(files, {
    mode: 'required',
    applicability: 'web',
    required: ['content-security-policy','strict-transport-security','x-content-type-options','referrer-policy','permissions-policy','frame-protection']
  });
  assert.ok(result.missing.includes('content-security-policy'));
  assert.ok(result.missing.includes('strict-transport-security'));
  assert.ok(result.missing.includes('permissions-policy'));
});

test('test-only fail-closed auth secret fallback is not reported', () => {
  const root = tempRepo({
    'src/auth.ts': "const rawSecret = process.env.AUTH_SECRET || process.env.JWT_SECRET; if (!rawSecret && process.env.NODE_ENV !== 'test') { process.exit(1); } const AUTH_SECRET = rawSecret || 'app-test-only-secret-do-not-use-in-production';"
  });
  try {
    const result = scanRepository(root, cfg());
    assert.equal(result.findings.some((x) => x.id === 'AUTH_SECRET_FALLBACK'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsafe production auth secret fallback is still reported', () => {
  const root = tempRepo({
    'src/auth.ts': "const AUTH_SECRET = process.env.AUTH_SECRET || 'hardcoded-production-secret';"
  });
  try {
    const result = scanRepository(root, cfg());
    assert.ok(result.findings.some((x) => x.id === 'AUTH_SECRET_FALLBACK' && x.severity === 'P1'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generic unsafe raw query API is review-required but not automatically P0', () => {
  const root = tempRepo({
    'scripts/migrate.ts': "const sql = 'ALTER TABLE x ADD COLUMN y INT'; await prisma.$executeRawUnsafe(sql);"
  });
  try {
    const result = scanRepository(root, cfg());
    assert.ok(result.findings.some((x) => x.id === 'RAW_UNSAFE_QUERY' && x.severity === 'P2'));
    assert.equal(result.findings.some((x) => x.id === 'RAW_UNSAFE_QUERY_DYNAMIC'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dynamic unsafe raw query remains P0', () => {
  const root = tempRepo({
    'src/search.ts': "await prisma.$queryRawUnsafe(\`SELECT * FROM users WHERE email = '${req.body.email}'\`);"
  });
  try {
    const result = scanRepository(root, cfg());
    assert.ok(result.findings.some((x) => x.id === 'RAW_UNSAFE_QUERY_DYNAMIC' && x.severity === 'P0'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('webhook secret that disables verification when absent is reported', () => {
  const root = tempRepo({
    'src/webhook.ts': "const webhookSecret = process.env.MONIEPOINT_WEBHOOK_SECRET; if (webhookSecret) { verify(signature, webhookSecret); } persist(body);"
  });
  try {
    const result = scanRepository(root, cfg());
    assert.ok(result.findings.some((x) => x.id === 'WEBHOOK_SECRET_OPTIONAL' && x.severity === 'P1'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repository secret detection still scans markdown excluded from code heuristics', () => {
  const root = tempRepo({
    'docs/deploy.md': 'DATABASE_URL="mysql://produser:SuperSecretPassword123@localhost:3306/app"'
  });
  try {
    const result = scanRepository(root, cfg());
    assert.ok(result.findings.some((x) => x.id === 'REPOSITORY_SECRET_EXPOSURE' && x.severity === 'P0' && x.path === 'docs/deploy.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
