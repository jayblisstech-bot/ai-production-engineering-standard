const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../scripts/call-review-gateway');

test('gateway deadline preserves only committed chunks and refuses publication/success', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apes-deadline-'));
  const checkpointPath = path.join(dir,'checkpoint.json');
  const diffPath = path.join(dir,'diff.txt');
  const filesPath = path.join(dir,'files.txt');
  const fileDiff = (name, letter) => 'diff --git a/'+name+' b/'+name+'\nindex 1..2 100644\n--- a/'+name+'\n+++ b/'+name+'\n@@ -1,1 +1,1 @@\n+'+letter.repeat(210)+'\n';
  fs.writeFileSync(diffPath, fileDiff('a.js','a')+fileDiff('b.js','b'));
  fs.writeFileSync(filesPath, 'a.js\nb.js\n');
  fs.writeFileSync(path.join(dir,'.apes.json'), JSON.stringify({version:1,review:{maxChunkChars:5000,maxChunkTokens:100,charsPerToken:4}}));
  const oldNow = Date.now;
  const start = 50000000;
  let now = start;
  Date.now = () => now;
  const deadline = start + 180000;
  const env = {
    PROJECT_ROOT:dir, APES_CONFIG_PATH:'.apes.json', DIFF_TEXT_PATH:diffPath, CHANGED_FILES_FILE:filesPath,
    APES_CHECKPOINT_PATH:checkpointPath, GITHUB_REPOSITORY:'acme/test', PR_NUMBER:'11',
    HEAD_SHA:'c'.repeat(40), GITHUB_TOKEN:'test-token', MODEL_TIER:'medium',
    PR_TITLE:'Review', PR_BODY:'', GITHUB_OUTPUT:'', APES_REVIEW_DEADLINE_MS:String(deadline),
  };
  const saved = Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));
  Object.assign(process.env,env);
  const oldFetch = global.fetch;
  let fetches = 0, reviews = 0;
  global.fetch = async () => { fetches++; throw new Error('Publication should never be attempted'); };
  try {
    await assert.rejects(() => main({createHermes:()=>({
      async review({validate,deadlineMs}) {
        reviews++;
        assert.equal(deadlineMs, deadline-90000);
        if (reviews === 1) now = start+60000;
        else now = start+90001;
        return {validated:validate('{"findings":[]}'),provider:'fixture',model:'mock'};
      },
      publicTrace() { return []; },
    })}), e=>e.code==='REVIEW_DEADLINE_EXCEEDED');
    assert.equal(reviews, 2);
    assert.equal(fetches,0);
    const cp=JSON.parse(fs.readFileSync(checkpointPath,'utf8'));
    assert.deepEqual(Object.keys(cp.completedChunks), ['0']);
  } finally {
    Date.now = oldNow;
    global.fetch=oldFetch;
    for(const [key,value] of Object.entries(saved)) { if(value===undefined) delete process.env[key]; else process.env[key]=value; }
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
