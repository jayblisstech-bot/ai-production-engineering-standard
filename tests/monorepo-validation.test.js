const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runValidation } = require('../scripts/run-validation');
const { DEFAULT_CONFIG } = require('../scripts/lib');

function makeProject(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name,
    scripts: { check: "node -e \"process.exit(0)\"" }
  }));
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name, lockfileVersion: 3, packages: {} }));
}

test('monorepo validation supports multiple configured Node projects without a root package.json', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-monorepo-'));
  try {
    makeProject(root, 'backend');
    makeProject(root, 'frontend');
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    config.runtime.projects = [
      { path: 'backend', requiredScripts: ['check'], optionalScripts: [], allowUnlockedInstall: false },
      { path: 'frontend', requiredScripts: ['check'], optionalScripts: [], allowUnlockedInstall: false }
    ];
    const result = runValidation({ projectRoot: root, config, install: false });
    assert.equal(result.projects.length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
