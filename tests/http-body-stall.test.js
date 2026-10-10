const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {callOpenAI,callAnthropic,callOpenRouter} = require('../scripts/provider-clients');
const {GeminiCredentialPool} = require('../scripts/gemini-credential-pool');
const {fetchExistingFindingMarkers,postInlineComment} = require('../scripts/call-review-gateway');

async function bodyStall(operation, fakeFetch = null) {
  const server = http.createServer((_req,res) => {
    res.writeHead(200, {'content-type':'application/json'});
    res.flushHeaders();
    res.write('{"partial":');
    // Intentionally never end the response body.
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const address = 'http://127.0.0.1:' + server.address().port;
  const nativeFetch = global.fetch;
  // Test-owned cancellation provides cleanup even when production timeout logic
  // is deliberately mutated away. Otherwise CI would hang until the job timeout.
  const testAbort = new AbortController();
  global.fetch = (url, opts = {}) => {
    if (opts.signal?.aborted) testAbort.abort();
    else opts.signal?.addEventListener('abort', () => testAbort.abort(), {once:true});
    const forwarded = {...opts, signal:testAbort.signal};
    return fakeFetch
      ? fakeFetch(url, forwarded, address, nativeFetch)
      : nativeFetch(address, forwarded);
  };
  const start = Date.now();
  let watchdog;
  try {
    await Promise.race([
      operation(),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('Body-stall timeout regression: no abort before 1800 ms')), 1800);
      }),
    ]);
    const elapsed = Date.now()-start;
    assert.ok(elapsed < 1800, 'response body hang must terminate before watchdog: '+elapsed+'ms');
    assert.ok(elapsed >= 100, 'test must wait for an actual abort');
  } finally {
    clearTimeout(watchdog);
    testAbort.abort();
    global.fetch=nativeFetch;
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
}

for (const [name,client] of [['OpenAI',callOpenAI],['Anthropic',callAnthropic],['OpenRouter',callOpenRouter]]) {
  test(name+' aborts body-phase HTTP stalls before per-request timeout',{timeout:4000},async()=>{
    await bodyStall(async()=>{
      await assert.rejects(()=>client('model','s','u',250,'test-key'),
        e => e.code==='NETWORK');
    });
  });
}

test('Gemini aborts body-phase stall within shared deadline',{timeout:4000},async()=>{
  await bodyStall(async()=>{
    const pool=new GeminiCredentialPool([{id:'p1',key:'key'}],{
      timeoutMs:1000,maxRetriesPerCredential:0,modelBudgetMs:5000
    });
    await assert.rejects(()=>pool.request('model','s','u',{deadlineMs:Date.now()+250}),
      e => e.code==='REVIEW_DEADLINE_EXCEEDED');
  });
});

test('GitHub comment GET bounds the response body by absolute deadline',{timeout:4000},async()=>{
  await bodyStall(async()=>{
    await assert.rejects(
      ()=>fetchExistingFindingMarkers('owner','repo',7,'head',Date.now()+250),
      e => e.code==='REVIEW_DEADLINE_EXCEEDED');
  });
});

test('GitHub review comment POST bounds the response body by absolute deadline',{timeout:4000},async()=>{
  let posts=0;
  await bodyStall(async()=>{
    const finding={path:'src/a.js',line:8,side:'RIGHT',severity:'P1',comment:'defect'};
    await assert.rejects(
      ()=>postInlineComment('owner','repo',7,'head',finding,new Set(),Date.now()+250),
      e => e.code==='REVIEW_DEADLINE_EXCEEDED');
    assert.equal(posts,1);
  },async(_url,opts,endpoint,nativeFetch)=>{
    if(opts.method==='POST'){posts++;return nativeFetch(endpoint,opts);}
    return new Response('[]',{status:200,headers:{'content-type':'application/json'}});
  });
});
