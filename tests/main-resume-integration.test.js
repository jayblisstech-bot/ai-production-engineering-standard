const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../scripts/call-review-gateway');

test('actual main orchestration resumes after chunk failure without rerunning a committed chunk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-main-resume-'));
  const checkpointPath = path.join(dir, 'checkpoint.json');
  const diffPath = path.join(dir, 'review.diff');
  const filesPath = path.join(dir, 'files.txt');
  const fileDiff = (name, letter) => 'diff --git a/' + name + ' b/' + name + '\nindex 1..2 100644\n--- a/' + name + '\n+++ b/' + name + '\n@@ -1,1 +1,1 @@\n+' + letter.repeat(210) + '\n';
  fs.writeFileSync(diffPath, fileDiff('a.js', 'a') + fileDiff('b.js', 'b'));
  fs.writeFileSync(filesPath, 'a.js\nb.js\n');
  fs.writeFileSync(path.join(dir, '.apes.json'), JSON.stringify({ version: 1, review: { maxChunkChars: 5000, maxChunkTokens: 100, charsPerToken: 4 } }));
  const values = { PROJECT_ROOT: dir, APES_CONFIG_PATH: '.apes.json', DIFF_TEXT_PATH: diffPath, CHANGED_FILES_FILE: filesPath, APES_CHECKPOINT_PATH: checkpointPath, GITHUB_REPOSITORY: 'acme/test', PR_NUMBER: '7', HEAD_SHA: 'a'.repeat(40), GITHUB_TOKEN: 'test-token', MODEL_TIER: 'medium', PR_TITLE: 'Test', PR_BODY: 'Review this', GITHUB_OUTPUT: '' };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => {
    if (options.method === 'POST') throw new Error('No findings should be posted');
    return { ok: true, json: async () => [], text: async () => '' };
  };
  const firstCalls = [];
  const resumedCalls = [];
  const fakeFactory = (calls, failAt) => () => ({
    async review({ userPrompt, validate }) {
      calls.push(userPrompt);
      if (calls.length === failAt) throw new Error('intentional chunk failure');
      return { validated: validate(JSON.stringify({ findings: [] })), provider: 'stub', model: 'model' };
    },
    publicTrace() { return []; },
  });
  try {
    await assert.rejects(() => main({ createHermes: fakeFactory(firstCalls, 2) }), /intentional chunk failure/);
    assert.equal(firstCalls.length, 2);
    const partial = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    assert.deepEqual(Object.keys(partial.completedChunks), ['0']);
    await main({ createHermes: fakeFactory(resumedCalls, -1) });
    assert.equal(resumedCalls.length, 1, 'resumed run must execute only the uncommitted chunk');
    const complete = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    assert.deepEqual(Object.keys(complete.completedChunks).sort(), ['0', '1']);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
