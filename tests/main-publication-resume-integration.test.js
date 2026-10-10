const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main, findingMarker } = require('../scripts/call-review-gateway');

test('main path resumes partially published findings without duplicate comments', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-publication-'));
  const diff = path.join(dir, 'diff');
  const changed = path.join(dir, 'changed');
  const checkpoint = path.join(dir, 'checkpoint.json');
  fs.writeFileSync(diff, 'diff --git a/a.js b/a.js\nindex 1..2 100644\n--- a/a.js\n+++ b/a.js\n@@ -1,0 +1,2 @@\n+const first = 1;\n+const second = 2;\n');
  fs.writeFileSync(changed, 'a.js\n');
  fs.writeFileSync(path.join(dir, '.apes.json'), JSON.stringify({ version: 1 }));
  const head = 'c'.repeat(40);
  const env = { PROJECT_ROOT: dir, APES_CONFIG_PATH: '.apes.json', DIFF_TEXT_PATH: diff, CHANGED_FILES_FILE: changed, APES_CHECKPOINT_PATH: checkpoint, GITHUB_REPOSITORY: 'example/test', PR_NUMBER: '8', HEAD_SHA: head, GITHUB_TOKEN: 'fake-token', PR_TITLE: 'review', PR_BODY: '', MODEL_TIER: 'medium', GITHUB_OUTPUT: '' };
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const findings = [
    { path: 'a.js', line: 1, side: 'RIGHT', severity: 'P1', comment: 'First problem.' },
    { path: 'a.js', line: 2, side: 'RIGHT', severity: 'P1', comment: 'Second problem.' },
  ];
  let providerCalls = 0;
  let postCalls = 0;
  let failSecond = true;
  const published = [];
  const fake = () => ({
    async review({ validate }) { providerCalls++; return { validated: validate(JSON.stringify({ findings })), provider: 'stub', model: 'test' }; },
    publicTrace() { return []; },
  });
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => {
    if (options.method !== 'POST') return { ok: true, json: async () => published.map((f) => ({ commit_id: head, user: { login: 'github-actions[bot]', id: 41898282 }, body: findingMarker(head, f) })) };
    postCalls++;
    const payload = JSON.parse(options.body);
    if (failSecond && postCalls === 2) return { ok: false, status: 500, text: async () => 'temporary failure' };
    const finding = findings.find((f) => f.line === payload.line);
    if (!finding) throw new Error('Unrecognized finding');
    published.push(finding);
    return { ok: true, json: async () => ({}) };
  };
  try {
    await assert.rejects(() => main({ createHermes: fake }), /Failed to post required inline review comment/);
    assert.equal(providerCalls, 1);
    assert.equal(published.length, 1);
    failSecond = false;
    await main({ createHermes: fake });
    assert.equal(providerCalls, 1, 'review provider must not rerun committed chunk');
    assert.equal(postCalls, 3, 'only missing comment should be retried');
    assert.deepEqual(published.map((f) => f.line), [1, 2]);
  } finally {
    global.fetch = originalFetch;
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
