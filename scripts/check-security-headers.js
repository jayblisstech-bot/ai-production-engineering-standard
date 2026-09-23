#!/usr/bin/env node

const DEFAULT_REQUIRED = [
  'content-security-policy',
  'strict-transport-security',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'frame-protection',
];

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function evaluateResponseHeaders(headers, required = DEFAULT_REQUIRED) {
  const failures = [];
  const values = {
    csp: getHeader(headers, 'content-security-policy'),
    hsts: getHeader(headers, 'strict-transport-security'),
    xcto: getHeader(headers, 'x-content-type-options'),
    referrer: getHeader(headers, 'referrer-policy'),
    permissions: getHeader(headers, 'permissions-policy'),
    xframe: getHeader(headers, 'x-frame-options'),
  };

  if (required.includes('content-security-policy') && !values.csp.trim()) {
    failures.push('Content-Security-Policy is missing.');
  }

  if (required.includes('strict-transport-security')) {
    if (!values.hsts.trim()) {
      failures.push('Strict-Transport-Security is missing.');
    } else {
      const match = values.hsts.match(/max-age\s*=\s*(\d+)/i);
      if (!match || Number(match[1]) < 15552000) failures.push('Strict-Transport-Security max-age must be at least 15552000 seconds.');
    }
  }

  if (required.includes('x-content-type-options') && values.xcto.trim().toLowerCase() !== 'nosniff') {
    failures.push('X-Content-Type-Options must be nosniff.');
  }

  if (required.includes('referrer-policy')) {
    if (!values.referrer.trim()) failures.push('Referrer-Policy is missing.');
    else if (/\bunsafe-url\b/i.test(values.referrer)) failures.push('Referrer-Policy must not use unsafe-url.');
  }

  if (required.includes('permissions-policy') && !values.permissions.trim()) {
    failures.push('Permissions-Policy is missing.');
  }

  if (required.includes('frame-protection')) {
    const cspFrameAncestors = /(?:^|;)\s*frame-ancestors\s+[^;]+/i.test(values.csp);
    const xFrameSafe = /^(?:DENY|SAMEORIGIN)$/i.test(values.xframe.trim());
    if (!cspFrameAncestors && !xFrameSafe) failures.push('Frame protection is missing: configure CSP frame-ancestors or X-Frame-Options DENY/SAMEORIGIN.');
  }

  return { pass: failures.length === 0, failures, values };
}

async function probeSecurityHeaders(url, required = DEFAULT_REQUIRED) {
  if (!/^https:\/\//i.test(url)) throw new Error('APES production security-header probe requires an HTTPS URL.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'APES-Security-Headers-Probe/1.0' },
    });
    const result = evaluateResponseHeaders(response.headers, required);
    return {
      ...result,
      status: response.status,
      finalUrl: response.url,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const url = process.env.SECURITY_HEADERS_URL || process.argv[2];
  if (!url) throw new Error('Usage: SECURITY_HEADERS_URL=https://staging.example.com node scripts/check-security-headers.js');
  const result = await probeSecurityHeaders(url);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) {
    console.error('APES runtime security-header verification FAILED:');
    result.failures.forEach((failure) => console.error('- ' + failure));
    process.exit(1);
  }
  console.log('APES runtime security-header verification passed.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { DEFAULT_REQUIRED, getHeader, evaluateResponseHeaders, probeSecurityHeaders };
