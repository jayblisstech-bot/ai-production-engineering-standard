# APES PR #8 + PR #9 isolated integration verification

**Status:** Experimental integration branch only. **No merge or production authorization.**

## Provenance

- Base: PR #8 at `4c77f2a13280c29125c4feaf66ae378891fe0847` (checkpointed failover, global deadline, provider timeouts and fail-closed publication).
- Ported from: PR #9 at `06e1ea67959f193c761c9a7351e928706aea90db` (complete oversized/medium hunk splitting and bounded first-fit-decreasing packing).
- Excluded: PR #10 concurrency executor and all associated opt-in configuration. The review remains sequential, with one provider call at a time.

## Integration behavior and safeguards

- The **AI review only** receives `git diff --no-ext-diff --unified=3`, preserving changed lines while reducing unchanged context. Deterministic checks and security/secret scanning still receive the existing `--unified=80` context.
- Review chunks split oversized/medium hunks while retaining original path, old/new line numbers and changed-line content. An indivisible oversized changed line fails closed.
- First-fit-decreasing packing is bounded by **both** PR #8's `maxChunkTokens`/`charsPerToken` configuration and the existing `maxChunkChars` and `maxChunks` caps. The changed chunk plan has a distinct checkpoint plan hash, invalidating incompatible prior checkpoint state.
- Per-file `diffLineIndex` collects the union of changed anchors when several independently headed fragments of the **same file** share a review chunk; previously, only the final fragment's lines were indexed.
- Checkpoints, global/per-provider time budgets, secret redaction, publication safeguards, GitHub Actions concurrency and fail-closed quality gates are retained from PR #8.
- Existing project template remains pinned to its previous approved runtime until a separate explicit owner-reviewed upgrade. Do not substitute this branch ref for an immutable release SHA.

## Tests and verification

- `tests/oversized-hunk-chunking.test.js`: full PR #9 hunk split, packing and context-scope regressions, extended with repeated-path line-index coverage, full changed-line anchor coverage and an assertion that execution remains sequential.
- `tests/review-chunking.test.js` and the PR #8 resilience tests remain applicable; validate token/character caps, checkpoint durability and fail-closed behavior together.
- `.github/workflows/apes-pr8-pr9-integration-test.yml` runs `npm test` on **integration-branch pushes only**, under Node 20, with `contents: read` and no external-provider secrets. No live provider review is authorized by that workflow.
- CI outcomes must be explicitly verified before the integration can be proposed for merging; presence of a workflow is not proof of a passing run.

## Unresolved release blockers

1. Independent code review of the **integrated** exact HEAD and a verified all-green test run, including security/architecture checks.
2. Bounded, explicitly approved GitHub Actions live-provider testing of AI review timeout, checkpoint interruption/resume and template caller permissions.
3. Explicit release approval/immutable SHA pin; follow-up Numerra candidate checks and its independent browser acceptance.
4. Cross-process review-publication race and uncaptured provider error bodies remain documented limitations. Do not silently waive security gates.
