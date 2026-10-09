const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../scripts/call-review-gateway');

test('actual main orchestration compacts context and retries only the incomplete chunk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-main-compact-'));
  const checkpointPath = path.join(dir, 'state.json');
  const diffPath = path.join(dir, 'diff.txt');
  const filesPath = path.join(dir, 'files.txt');
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'PROJECT_ARCHITECTURE.md'), 'A'.repeat(6200));
  fs.writeFileSync(path.join(dir, 'docs', 'BUSINESS_RULES.md'), 'B'.repeat(6200));
  fs.writeFileSync(path.join(dir, '.apes.json'), JSON.stringify({ version: 1 }));
  fs.writeFileSync(diffPath, 'diff --git a/a.js b/a.js\nindex 1..2 100644\n--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n+const x = 1;\n');
  fs.writeFileSync(filesPath, 'a.js\n');
  const env = { PROJECT_ROOT: dir, APES_CONFIG_PATH: '.apes.json', DIFF_TEXT_PATH: diffPath, CHANGED_FILES_FILE: filesPath, APES_CHECKPOINT_PATH: checkpointPath, GITHUB_REPOSITORY: 'example/repo', PR_NUMBER: '88', HEAD_SHA: 'b'.repeat(40), GITHUB_TOKEN: 'test', PR_TITLE: 'Test', PR_BODY: '', MODEL_TIER: 'medium', GITHUB_OUTPUT: '' };
  const prev = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => options.method === 'POST' ? { ok: true } : { ok: true, json: async () => [] };
  const prompts = [];
  const fake = () => ({
    async review({ userPrompt, validate }) {
      prompts.push(userPrompt);
      if (prompts.length === 1) throw Object.assign(new Error('provider context exceeded'), { code: 'CONTEXT_OVERFLOW' });
      return { validated: validate('{"findings":[]}'), provider: 'stub', model: 'model' };
    },
    publicTrace() { return []; },
  });
  try {
    await main({ createHermes: fake });
    assert.equal(prompts.length, 2);
    assert.ok(prompts[1].length < prompts[0].length);
    assert.equal(JSON.parse(fs.readFileSync(checkpointPath, 'utf8')).completedChunks['0'].chunkIndex, 0);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(prev)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
