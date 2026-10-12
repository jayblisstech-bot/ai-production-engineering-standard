'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { authenticateGatewayRun } = require('../gateway/run-identity-contract');
const sha = (c) => c.repeat(40);
const binding = Object.freeze({
 repository: 'example/repo', prNumber: '7', runId: '12345', attempt: '2',
 headSha: sha('a'), baseSha: sha('b'), pipelineSha: sha('c'),
});
function setup() {
 const expected = {
  binding, audience: 'apes-gateway:review', ownerId: 77, repositoryId: 99,
  checkoutSha: sha('d'), ref: 'refs/pull/7/merge',
  jobWorkflowRef: 'example/apes/.github/workflows/review.yml@refs/heads/main',
  confirmGitHubBinding: async () => true,
 };
 const claims = {
  iss: 'https://token.actions.githubusercontent.com', aud: expected.audience,
  repository: binding.repository, event_name: 'pull_request',
  repository_owner_id: '77', repository_id: '99',
  run_id: binding.runId, run_attempt: binding.attempt, sha: expected.checkoutSha,
  workflow_sha: binding.pipelineSha, ref: expected.ref,
  job_workflow_ref: expected.jobWorkflowRef,
 };
 return { expected, claims };
}
test('requires verified JWT and exact server-confirmed run binding', async () => {
 const { expected, claims } = setup();
 const result = await authenticateGatewayRun({token:'signed-token',verifyJwt: async () => claims,expected});
 assert.equal(result.repository,'example/repo');
 assert.equal(result.attempt,'2');
});
for (const field of ['iss','aud','repository','event_name','repository_owner_id',
 'repository_id','run_id','run_attempt','sha','workflow_sha','ref','job_workflow_ref']) {
 test('rejects mismatched verified claim: '+field, async () => {
  const { expected, claims } = setup();
  claims[field] = 'attacker';
  await assert.rejects(authenticateGatewayRun({token:'signed-token',verifyJwt:async()=>claims,expected}), /IDENTITY_DENIED/);
 });
}
test('rejects verifier failure and token absence', async () => {
 const { expected } = setup();
 await assert.rejects(authenticateGatewayRun({token:'bad',verifyJwt:async()=>{throw Error('invalid signature');},expected}), /IDENTITY_DENIED/);
 await assert.rejects(authenticateGatewayRun({token:'',verifyJwt:async()=>({}),expected}), /IDENTITY_DENIED/);
});
test('denies missing and negative trusted GitHub confirmation', async () => {
 const { expected, claims } = setup();
 delete expected.confirmGitHubBinding;
 await assert.rejects(authenticateGatewayRun({token:'signed',verifyJwt:async()=>claims,expected}), /IDENTITY_DENIED/);
 expected.confirmGitHubBinding = async()=>false;
 await assert.rejects(authenticateGatewayRun({token:'signed',verifyJwt:async()=>claims,expected}), /IDENTITY_DENIED/);
 expected.confirmGitHubBinding = async()=>{throw Error('GitHub unavailable');};
 await assert.rejects(authenticateGatewayRun({token:'signed',verifyJwt:async()=>claims,expected}), /IDENTITY_DENIED/);
});
test('rejects untrusted audience or malformed checkout SHA', async()=>{
 const {expected,claims}=setup();
 expected.audience='other';
 claims.aud='other';
 await assert.rejects(authenticateGatewayRun({token:'signed',verifyJwt:async()=>claims,expected}), /IDENTITY_DENIED/);
 expected.audience='apes-gateway:review';
 claims.aud=expected.audience;
 expected.checkoutSha='incorrect';
 claims.sha='incorrect';
 await assert.rejects(authenticateGatewayRun({token:'signed',verifyJwt:async()=>claims,expected}), /IDENTITY_DENIED/);
});
