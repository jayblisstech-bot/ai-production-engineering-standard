#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig, assertSafeProjectPath } = require('./lib');

function exec(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${r.status}`);
}

function detectPackageManager(root, pkg) {
  const declared = pkg.packageManager || '';
  if (declared.startsWith('pnpm@')) return { name: 'pnpm', version: declared.split('@')[1] };
  if (declared.startsWith('yarn@')) return { name: 'yarn', version: declared.split('@')[1] };
  if (declared.startsWith('npm@')) return { name: 'npm', version: declared.split('@')[1] };
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return { name: 'pnpm' };
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return { name: 'yarn' };
  return { name: 'npm' };
}

function installDependencies(pm, root, allowUnlockedInstall) {
  const hasLock = fs.existsSync(path.join(root, 'package-lock.json')) || fs.existsSync(path.join(root, 'pnpm-lock.yaml')) || fs.existsSync(path.join(root, 'yarn.lock'));
  if (!hasLock && !allowUnlockedInstall) throw new Error('No supported lockfile found. APES refuses an unlocked dependency install.');
  if (pm.name === 'npm') exec('npm', hasLock ? ['ci'] : ['install'], root);
  else if (pm.name === 'pnpm') exec('pnpm', ['install', ...(hasLock ? ['--frozen-lockfile'] : [])], root);
  else if (pm.name === 'yarn') {
    const major = Number((pm.version || '1').split('.')[0]);
    exec('yarn', ['install', ...(hasLock ? [major >= 2 ? '--immutable' : '--frozen-lockfile'] : [])], root);
  } else throw new Error(`Unsupported package manager: ${pm.name}`);
}

function validateNodeProject({ root, requiredScripts, optionalScripts, allowUnlockedInstall, install }) {
  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) throw new Error(\`Node project package.json is missing: \${pkgPath}\`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const scripts = pkg.scripts || {};
  const pm = detectPackageManager(root, pkg);

  for (const name of requiredScripts || []) {
    if (!scripts[name]) throw new Error(\`Required validation script '\${name}' is missing from \${pkgPath}.\`);
  }
  if (install) installDependencies(pm, root, !!allowUnlockedInstall);

  const runner = pm.name === 'npm' ? ['npm', ['run']] : pm.name === 'pnpm' ? ['pnpm', ['run']] : ['yarn', []];
  for (const name of requiredScripts || []) exec(runner[0], [...runner[1], name], root);
  for (const name of optionalScripts || []) {
    if (scripts[name]) exec(runner[0], [...runner[1], name], root);
    else console.log(\`Optional validation script '\${name}' is not defined in \${pkgPath}; skipping.\`);
  }
  return { root, packageManager: pm.name, required: requiredScripts || [], optional: optionalScripts || [] };
}

function runValidation({ projectRoot, config, install = true }) {
  if (config.runtime.type !== 'node') throw new Error(\`Unsupported APES runtime type: \${config.runtime.type}. Add a runtime adapter before enabling the gate.\`);
  const projects = config.runtime.projects || [];
  if (!projects.length) {
    return validateNodeProject({
      root: projectRoot,
      requiredScripts: config.runtime.requiredScripts,
      optionalScripts: config.runtime.optionalScripts,
      allowUnlockedInstall: config.runtime.allowUnlockedInstall,
      install,
    });
  }

  const results = [];
  for (const project of projects) {
    const root = assertSafeProjectPath(projectRoot, project.path);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(\`Configured runtime project does not exist: \${project.path}\`);
    console.log(\`\\n=== APES validation project: \${project.path} ===\`);
    results.push(validateNodeProject({
      root,
      requiredScripts: project.requiredScripts ?? config.runtime.requiredScripts,
      optionalScripts: project.optionalScripts ?? config.runtime.optionalScripts,
      allowUnlockedInstall: project.allowUnlockedInstall ?? config.runtime.allowUnlockedInstall,
      install,
    }));
  }
  return { projects: results };
}
function main() {
  const projectRoot = path.resolve(process.env.PROJECT_ROOT || process.cwd());
  const config = loadConfig(projectRoot, process.env.APES_CONFIG_PATH || '.apes.json');
  runValidation({ projectRoot, config, install: process.env.SKIP_INSTALL !== '1' });
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.stack || err.message); process.exit(1); }
}
module.exports = { detectPackageManager, installDependencies, validateNodeProject, runValidation };
