#!/usr/bin/env node
const path = require('path');
const { loadConfig } = require('./lib');
const { probeSecurityHeaders } = require('./check-security-headers');

async function main() {
  const projectRoot = path.resolve(process.env.PROJECT_ROOT || process.cwd());
  const config = loadConfig(projectRoot, process.env.APES_CONFIG_PATH || '.apes.json');
  const headerConfig = config.security.headers;

  if (!headerConfig || headerConfig.mode === 'off' || !headerConfig.runtimeUrl) {
    console.log('No APES runtime security-header URL configured; skipping live probe.');
    return;
  }

  try {
    const result = await probeSecurityHeaders(headerConfig.runtimeUrl, headerConfig.required);
    console.log(JSON.stringify(result, null, 2));
    if (!result.pass) throw new Error(result.failures.join(' | '));
    if (process.env.GITHUB_ENV) {
      require('fs').appendFileSync(process.env.GITHUB_ENV, 'APES_RUNTIME_HEADERS_VERIFIED=1\n');
    }
    console.log('APES configured runtime security-header verification passed.');
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (headerConfig.mode === 'required') throw new Error('Required runtime security-header verification failed: ' + message);
    console.warn('AUDIT MODE: runtime security-header verification did not pass: ' + message);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
