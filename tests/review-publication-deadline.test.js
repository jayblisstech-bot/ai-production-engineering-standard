const test=require('node:test');
const assert=require('node:assert/strict');
const {fetchExistingFindingMarkers,postInlineComment}=require('../scripts/call-review-gateway');

test('GitHub publication preflight fails closed if a response crosses the absolute deadline', async()=>{
  const previousFetch=global.fetch,previousNow=Date.now;
  let now=100000;
  Date.now=()=>now;
  global.fetch=async()=>{now=102000;return {ok:true,json:async()=>[]};};
  try{
    await assert.rejects(()=>fetchExistingFindingMarkers('owner','repo',7,'head',101000),err=>err.code==='REVIEW_DEADLINE_EXCEEDED');
  }finally{global.fetch=previousFetch;Date.now=previousNow;}
});

test('expired deadline blocks inline review comment POST before it starts', async()=>{
  const previousFetch=global.fetch,previousNow=Date.now;
  Date.now=()=>105000;
  let posts=0;
  global.fetch=async()=>{posts++;return {ok:true};};
  const finding={path:'src/a.js',line:1,side:'RIGHT',severity:'P1',comment:'Issue'};
  try{
    await assert.rejects(()=>postInlineComment('owner','repo',7,'head',finding,new Set(),104000),err=>err.code==='REVIEW_DEADLINE_EXCEEDED');
    assert.equal(posts,0);
  }finally{global.fetch=previousFetch;Date.now=previousNow;}
});
