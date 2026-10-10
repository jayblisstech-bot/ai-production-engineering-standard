# APES checkpointed review and provider resilience

This document describes the implementation on `feat/checkpointed-provider-failover`, not a production release guarantee. Do not enable the branch for downstream production callers until the open PR passes independent review and is explicitly approved.

## Gemini credential and model failover

- Gemini credentials are independent project/account capacity boundaries. For a selected model, the pool attempts all currently eligible credentials under the default policy before model fallback.
- HTTP 429 is credential/model scoped. Honor `Retry-After` where appropriate, cool down that credential/model combination, and rotate to another eligible project.
- Structured invalid-key errors (`API_KEY_INVALID`, including HTTP 400) and HTTP 401 quarantine the affected credential. HTTP 403 is model/credential scoped rather than indiscriminate account-wide quarantine.
- Model 404 marks the selected model unavailable for the current run. Network failures and 5xx errors use bounded retries/cooldowns; a persistent provider failure moves on according to model fallback.
- Token-count wording in a 429 does **not** mean the prompt exceeded the context window. Genuine context overflow on an appropriate client-error response takes the context-compaction route.
- Gemini API keys are sent using the supported `x-goog-api-key` header, never in the generation-request URL. Public telemetry uses opaque credential IDs.

## Work chunking and checkpoint integrity

- Deterministic diff chunks respect file/hunk boundaries and both character and estimated-token budgets. An indivisible oversized hunk fails explicitly rather than silently truncating the diff.
- The checkpoint identity includes the task, target/head and an ordered hash of chunks, review prompt, contextual evidence and review metadata. A changed contract is not considered the same completed task.
- Each valid chunk result is normalized, persisted to a temporary file and atomically renamed **before** the in-memory completion state changes. The temporary file is synchronized with `fsync` before the atomic rename, and directory synchronization is attempted on POSIX systems. These reduce data-loss risk, but do not guarantee durability across all hardware, filesystems, power failures or runner termination.
- Restored findings are validated against the current diff line index before being reused. Corrupt, schema-invalid or identity-mismatched checkpoints are quarantined and review starts again at chunk zero. Such recovery must be logged and is not reported as a successful resume.
- Checkpoints contain normalized findings and opaque provider route identifiers, not API keys. A chunk is complete only when its checkpoint commit succeeds. Failed or uncommitted chunks may be retried; valid completed chunks are skipped.
- Context compaction preserves as much validated project context as the limit allows. It is **not** a guarantee that every document section remains intact if a single section exceeds the budget.

## Caller workflow permissions and safe upgrades

- The project-repository workflow template explicitly grants `actions: read` together with `contents: read` and `pull-requests: write`. The called workflow cannot elevate permissions beyond its caller; checkpoint artifact discovery requires `actions: read`.
- The shipped caller template deliberately retains its historical reviewed runtime SHA until a new APES release is approved. Updating to the new checkpointed runtime requires intentionally pinning the called workflow and `pipeline_ref` to the approved exact commit, verifying permissions and running integration tests; this PR does not silently repin downstream applications.

## Review execution deadlines

- The AI-review job has a 20-minute GitHub Actions hard timeout. Its first step establishes an absolute 16-minute deadline, leaving four minutes of job-level buffer for termination and artifact handling. Standalone gateway calls default to a 15-minute budget if no absolute workflow deadline is provided.
- The gateway reserves the last 90 seconds of that review deadline for publication and final output; any unfinished model call or uncommitted chunk fails closed when its earlier provider deadline is reached.
- Hermes forwards one shared absolute deadline across every provider, capability and model; a fallback attempt does not restart the clock. Each network request is limited to the smaller of its configured timeout and the remaining deadline.
- Gemini independently limits attempts on any single model to two minutes across all credentials, then permits model fallback if the **global** deadline still allows it. An expired global deadline always stops the entire review, regardless of available credentials.
- Successfully persisted chunks survive deadline failure. Any unfinished chunk is not committed or published as a successful review. The artifact upload remains a best-effort `always()` step and cannot be guaranteed after forcible job cancellation.
- These deadlines reduce timeout risk but do not prove live Gemini/provider behavior or that a blocked GitHub API endpoint always completes before the Actions hard timeout.

## GitHub Actions artifact recovery

- The workflow associates a checkpoint with the same workflow identity, PR, head SHA and named non-expired artifact; same-run reruns can consider an artifact from an earlier attempt.
- Selected artifact downloads fail visibly on errors; no checkpoint means a fresh review, not a false resume.
- The artifact has seven-day retention and is uploaded on an `always()` step where an active checkpoint exists. The workflow may lose recent completed chunks if the runner is terminated before upload; job failure and artifact upload are not a transactional commit.
- Changing the PR head SHA invalidates old checkpoint state. Long-lived distributed exactly-once execution across different GitHub runs is not guaranteed. A controlled GitHub Actions failed-run rerun using a synthetic checkpoint fixture passed (run 37982428034, second attempt). It does not exercise provider calls or a genuinely cancelled AI-review job.

## Review finding publication

- Inline finding markers are scoped to the PR head SHA and are recognized only when authored by the known GitHub Actions bot identity.
- Pagination covers existing PR review comments. In-process concurrent publishing of the identical finding is serialized and rerun publication skips trusted markers already present.
- HTTP 422 posting errors are rechecked against trusted GitHub comments before being classified as a failure; genuinely unpostable findings fail the run.
- GitHub comment creation is **not atomic** with marker lookup. An external process that bypasses the per-PR GitHub Actions concurrency group can still race and duplicate a comment. Exact semantic deduplication of differently worded findings at the same location is also not proven.
- Publication must finish successfully before the AI job can report success. The final gate verifies the declared completed/required chunk counts and completed checkpoint status.

## Remaining release blockers

1. **Partly verified:** a real GitHub Actions synthetic-checkpoint failure/rerun with artifact restore passed (run 37982428034). A cancelled AI-review job exercising actual provider calls remains unverified.
2. Broader end-to-end failure-injection and meaningful mutation testing across the primary orchestration path.
3. Independently review publication races, comment fingerprint stability, and provider classification edge cases. PR-scoped GitHub Actions concurrency serializes the official workflow, but third-party writers bypassing the same concurrency group are not covered.
4. Check the reusable workflow's default `pipeline_ref` and all callers: the historical default may reference a runtime that predates checkpoints. Do not silently switch downstream apps to an unreviewed ref.
5. Confirm supply-chain scan, prompt-injection resilience, secret redaction, and real-workflow deadline behavior under provider/network stalls.
6. Obtain an independent reviewer verdict on the final commit and explicit human merge authorization.

**Current release policy:** draft PR, no merge, no production deployment, no downstream Numerra/SMMTAI changes.
