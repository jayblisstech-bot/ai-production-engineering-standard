const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_CONFIG } = require('../scripts/lib');
const { remainingDeadlineMs, boundedRequestTimeoutMs } = require('../scripts/review-deadline');
const { HermesOrchestrator } = require('../scripts/hermes-orchestrator');
const { GeminiCredentialPool } = require('../scripts/gemini-credential-pool');

test('deadline utility rejects elapsed budget and clamps provider timeout', () => {
  assert.equal(remainingDeadlineMs(1700, 1000), 700);
  assert.equal(boundedRequestTimeoutMs(90000, 1700, 1000), 700);
  assert.equal(boundedRequestTimeoutMs(100, 1700, 1000), 100);
  assert.throws(() => remainingDeadlineMs(1000, 1000), e => e.code === 'REVIEW_DEADLINE_EXCEEDED');
  assert.throws(() => remainingDeadlineMs(1000, 1001), e => e.code === 'REVIEW_DEADLINE_EXCEEDED');
  assert.throws(() => remainingDeadlineMs(NaN, 1000), /absolute positive integer/);
});

test('Hermes deadline prevents cascading through all models when time is exhausted', async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.review.allowedExternalProviders = ['openai'];
  config.review.routing.mode = 'direct';
  config.review.routing.modelCatalog.openai = { medium: ['m1','m2','m3'], strong: ['m4'], advanced: ['m5'] };
  const oldNow = Date.now;
  let now = 100000;
  Date.now = () => now;
  const calls = [];
  try {
    const hermes = new HermesOrchestrator({
      config, env: { OPENAI_API_KEY: 'test-key' },
      clients: { openai: async (model, sys, usr, timeoutMs) => {
        calls.push({model, timeoutMs});
        now += 800;
        throw Object.assign(new Error('simulated timeout'), { code: 'NETWORK', fallbackEligible: true });
      } },
    });
    await assert.rejects(() => hermes.review({
      modelTier:'medium', systemPrompt:'s', userPrompt:'u',
      validate: JSON.parse, deadlineMs:101500,
    }), e => e.code === 'REVIEW_DEADLINE_EXCEEDED');
    assert.deepEqual(calls.map(c => c.model), ['m1','m2']);
    assert.equal(calls[0].timeoutMs, 1500);
    assert.equal(calls[1].timeoutMs, 700);
  } finally { Date.now = oldNow; }
});

test('Gemini checks one shared deadline before exhausting independent credentials or falling back', async () => {
  const oldFetch = global.fetch, oldNow = Date.now;
  let now = 200000;
  let calls = 0;
  Date.now = () => now;
  global.fetch = async () => {
    calls++;
    now += 600;
    return new Response(JSON.stringify({error:{status:'RESOURCE_EXHAUSTED',message:'quota'}}), {status:429});
  };
  try {
    const pool = new GeminiCredentialPool(Array.from({length:9},(_,i)=>({id:'p'+i,key:'k'+i})),
      {maxRetriesPerCredential:0,timeoutMs:90000,cooldown429Ms:1000});
    await assert.rejects(() => pool.callModels(['first','second'],'system','user',{deadlineMs:201500}),
      e => e.code === 'REVIEW_DEADLINE_EXCEEDED');
    assert.equal(calls,3, 'model fallback and remaining project attempts must stop at deadline');
  } finally { global.fetch = oldFetch; Date.now = oldNow; }
});

test('Gemini per-model budget forces model fallback without waiting through every slow project', async () => {
  const oldFetch=global.fetch, oldNow=Date.now;
  let now=300000, firstCalls=0, fallbackCalls=0;
  Date.now=()=>now;
  global.fetch=async (url) => {
    if (String(url).includes('model-primary')) {
      firstCalls++;
      now+=70;
      return new Response(JSON.stringify({error:{status:'RESOURCE_EXHAUSTED',message:'quota'}}),{status:429});
    }
    fallbackCalls++;
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'{"findings":[]}'}]}}]}),{status:200});
  };
  try {
    const pool=new GeminiCredentialPool(Array.from({length:9},(_,i)=>({id:'p'+i,key:'key-'+i})),
      {modelBudgetMs:100, timeoutMs:90000, maxRetriesPerCredential:0,cooldown429Ms:1000});
    const result=await pool.callModels(['model-primary','model-next'],'s','u');
    assert.equal(result.model,'model-next');
    assert.equal(firstCalls,2);
    assert.equal(fallbackCalls,1);
  } finally { Date.now=oldNow;global.fetch=oldFetch; }
});
