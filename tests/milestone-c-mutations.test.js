'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = path.join(__dirname, '..');
const regressionTest = 'tests/milestone-c-transport.test.js';

function checkMutation(file, transform, testPattern, timeoutMs = 4500) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-c-mutation-'));
  try {
    fs.cpSync(path.join(repo, 'scripts'), path.join(work, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(work, 'tests'));
    fs.copyFileSync(path.join(repo, regressionTest), path.join(work, regressionTest));
    const filePath = path.join(work, file);
    const original = fs.readFileSync(filePath, 'utf8');
    const mutant = transform(original);
    assert.notEqual(mutant, original, 'mutation did not apply: ' + file);
    fs.writeFileSync(filePath, mutant);

    // Run ONLY the matching local mock test in a separate process. Hung body
    // mutations are forcibly killed by an independent test watchdog.
    const child = spawnSync(process.execPath, [
      '--test', '--test-name-pattern=' + testPattern, regressionTest,
    ], {
      cwd: work, encoding: 'utf8', timeout: timeoutMs,
      env: { ...process.env, OPENAI_API_KEY: '', OPENROUTER_API_KEY: '',
        ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', GEMINI_API_KEYS_JSON: '' },
    });
    const killed = child.error?.code === 'ETIMEDOUT';
    assert.ok(killed || (child.status !== null && child.status !== 0),
      'Safety mutation survived: ' + file + '\n' +
      String(child.stdout || '').slice(-1500) + '\n' + String(child.stderr || '').slice(-500));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

test('mutation: clearing timer after headers fails the stalled-body regression', { timeout: 7000 }, () => {
  checkMutation('scripts/http-bounded.js', (source) => source.replace(
    '      const raw = await readBody(res, maxBodyBytes, controller);',
    '      clearTimeout(timer); // deliberately defective\n      const raw = await readBody(res, maxBodyBytes, controller);',
  ), 'abort timer covers stalled response body', 4000);
});

test('mutation: unbounded Gemini 503 sleep fails retry deadline regression', { timeout: 7000 }, () => {
  checkMutation('scripts/gemini-credential-pool.js', (source) => source.replace(
    /await sleepWithDeadline\(Math\.min\([\s\S]*?checkModelBudget\(\)\), deadlineMs\);/g,
    'await new Promise(resolve => setTimeout(resolve, 2500));',
  ), 'Gemini 5xx backoff never overshoots', 4700);
});

test('mutation: skipping post-provider deadline checks fails Hermes regression', { timeout: 7000 }, () => {
  checkMutation('scripts/hermes-orchestrator.js', (source) => {
    let mutant = source.replace(
      '            remainingDeadlineMs(deadlineMs);\n            this.trace.push',
      '            // deliberately omit post-response deadline check\n            this.trace.push',
    );
    mutant = mutant.replace(
      '          try {\n            remainingDeadlineMs(deadlineMs);\n            const validated',
      '          try {\n            const validated',
    );
    return mutant;
  }, 'Hermes propagates absolute deadline', 4500);
});
