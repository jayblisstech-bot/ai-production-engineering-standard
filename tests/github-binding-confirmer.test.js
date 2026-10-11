'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createGitHubBindingConfirmer}=require('../gateway/github-binding-confirmer');
const sha=c=>c.repeat(40);
const binding={repository:'example/repo',prNumber:'7',runId:'12345',attempt:'2',headSha:sha('a'),baseSha:sha('b'),pipelineSha:sha('c')};
const repo={id:99,owner:{id:77},full_name:'example/repo'};
const pr={number:7,state:'open',head:{sha:binding.headSha,repo:{id:99}},base:{sha:binding.baseSha,ref:'main',repo:{id:99}}};
const run={id:12345,run_attempt:2,repository:{id:99},event:'pull_request',path:'.github/workflows/review.yml',status:'in_progress',pull_requests:[{number:7,head:{sha:binding.headSha},base:{sha:binding.baseSha}}]};
function setup(overrides={}) {
 const api={getRepository:async()=>overrides.repo??repo,getPullRequest:async()=>overrides.pr??pr,getWorkflowRun:async()=>overrides.run??run};
 return createGitHubBindingConfirmer({api,repositoryId:99,ownerId:77,workflowPath:'.github/workflows/review.yml',trustedBaseRef:'main'});
}
test('matches immutable repository, PR, run and base',async()=>assert.equal(await setup()(binding,binding),true));
const mutations=[
 ['repository takeover',{repo:{...repo,id:111}}],
 ['wrong owner',{repo:{...repo,owner:{id:111}}}],
 ['stale head',{pr:{...pr,head:{...pr.head,sha:sha('d')}}}],
 ['stale base',{pr:{...pr,base:{...pr.base,sha:sha('d')}}}],
 ['wrong trusted base',{pr:{...pr,base:{...pr.base,ref:'feature'}}}],
 ['fork',{pr:{...pr,head:{...pr.head,repo:{id:888}}}}],
 ['closed PR',{pr:{...pr,state:'closed'}}],
 ['run replay',{run:{...run,run_attempt:1}}],
 ['wrong workflow',{run:{...run,path:'.github/workflows/other.yml'}}],
 ['completed run',{run:{...run,status:'completed'}}],
 ['different run PR',{run:{...run,pull_requests:[{number:8,head:{sha:binding.headSha},base:{sha:binding.baseSha}}]}}],
 ['missing associated PR',{run:{...run,pull_requests:[]}}],
];
for(const [name,overrides] of mutations) test('denies '+name,async()=>assert.rejects(setup(overrides)(binding,binding),/BINDING_DENIED/));
test('denies altered caller run binding',async()=>{
 await assert.rejects(setup()({...binding,runId:'99999'},binding),/BINDING_DENIED/);
});
test('denies failed GitHub API',async()=>{
 const api={getRepository:async()=>{throw Error('offline')},getPullRequest:async()=>pr,getWorkflowRun:async()=>run};
 const check=createGitHubBindingConfirmer({api,repositoryId:99,ownerId:77,workflowPath:'.github/workflows/review.yml',trustedBaseRef:'main'});
 await assert.rejects(check(binding,binding),/BINDING_DENIED/);
});
