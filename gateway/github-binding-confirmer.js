'use strict';
/**
 * Server-side GitHub API binding confirmation contract, NOT a deployed service.
 * api must be an authenticated, gateway-controlled GitHub App client (never a
 * runner-supplied API object). The gateway must pin approved grants separately.
 */
const { assertBinding } = require('../scripts/review-dollar-budget');
const SHA = /^[0-9a-f]{40}$/;
function deny() { throw new Error('APES_GATEWAY_GITHUB_BINDING_DENIED'); }
function safeEqual(a,b) { return typeof a === 'string' && typeof b === 'string' && a === b; }
function createGitHubBindingConfirmer({ api, repositoryId, ownerId, workflowPath, trustedBaseRef }) {
  if (!api || !['getRepository','getPullRequest','getWorkflowRun'].every(x=>typeof api[x]==='function') ||
      !Number.isSafeInteger(repositoryId) || repositoryId <= 0 ||
      !Number.isSafeInteger(ownerId) || ownerId <= 0 ||
      typeof workflowPath !== 'string' || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflowPath) ||
      typeof trustedBaseRef !== 'string' || !/^[A-Za-z0-9._/-]{1,128}$/.test(trustedBaseRef)) deny();
  return async function confirmGitHubBinding(verifiedRun, suppliedBinding) {
    let binding;
    try { binding = assertBinding(suppliedBinding); } catch (_) { deny(); }
    if (!verifiedRun || !Object.keys(binding).every(k=>safeEqual(verifiedRun[k],binding[k])) ||
        !SHA.test(binding.headSha) || !SHA.test(binding.baseSha) ||
        !SHA.test(binding.pipelineSha)) deny();
    let repository, pr, run;
    try {
      [repository,pr,run] = await Promise.all([
        api.getRepository(binding.repository),
        api.getPullRequest(binding.repository,Number(binding.prNumber)),
        api.getWorkflowRun(binding.repository,Number(binding.runId))
      ]);
    } catch (_) { deny(); }
    if (!repository || repository.id !== repositoryId ||
        repository.owner?.id !== ownerId ||
        repository.full_name?.toLowerCase() !== binding.repository ||
        !pr || pr.number !== Number(binding.prNumber) || pr.state !== 'open' ||
        pr.base?.repo?.id !== repositoryId ||
        pr.head?.repo?.id !== repositoryId ||
        pr.head?.sha !== binding.headSha ||
        pr.base?.sha !== binding.baseSha ||
        pr.base?.ref !== trustedBaseRef ||
        !run || run.id !== Number(binding.runId) ||
        run.run_attempt !== Number(binding.attempt) ||
        run.repository?.id !== repositoryId ||
        run.event !== 'pull_request' ||
        run.path !== workflowPath ||
        run.status === 'completed' ||
        !Array.isArray(run.pull_requests) ||
        !run.pull_requests.some(p=>p.number===Number(binding.prNumber) &&
           p.head?.sha === binding.headSha && p.base?.sha === binding.baseSha)) deny();
    // The pipeline SHA is authorized through the signed OIDC workflow_sha
    // and independently approved release policy, not via untrusted PR data.
    // Never infer pipeline SHA from run.head_sha (often a merge commit).
    return true;
  };
}
module.exports = { createGitHubBindingConfirmer };
