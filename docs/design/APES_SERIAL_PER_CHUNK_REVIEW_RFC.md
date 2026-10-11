# APES RFC — Complete AI Reviews Under a Per-Job 20-Minute Cap

**Status:** DESIGN ONLY — no provider runs, no workflow changes, no production adoption.
**Observed failure:** Numerra PR #11 candidate `a710f390505014b93a11eda57664e34a87b1cea1`, Actions run `38154292695`, merged APES PR #9 at `b443f45dd5ba8435939aba97434b8b3a77c8fc91`.

## Evidence

Existing APES performs 9 bounded AI diff chunks in one sequential job limited to 20 minutes. Sanitization completed; chunk 1 START 16:11:09Z, VERIFIED 16:18:05Z (~6m56s); chunk 2 VERIFIED 16:29:17Z (~11m12s); chunk 3 START 16:29:17Z; GitHub cancelled the entire job 16:31:11Z. The resulting `quality-gate` failed closed. Other exact-SHA application, database and deterministic/security checks PASS. This result is not a completed AI risk verdict.

With measured chunks averaging ~9 minutes and 9 chunks, merely enabling two concurrent requests while retaining a 20-minute job is not sufficient for a complete review. No new provider call or retries are authorized.

## Proposed approach (review/approval required)

1. **Prepare trusted immutable review manifest** in its own deterministic job: checkout exact PR head and base commits; load policy from the protected base (not untrusted PR head); produce full `--unified=3` AI diff; scan raw diff for introduced secrets; redact outbound content; compute stable chunking under existing max 45,000 characters / 12 chunks with *all changed lines accounted for*. Record SHA-256 hashes of diff, chunk contents, PR head/base, config, immutable APES workflow commit. Refuse missing/overflow cases. Never publish sensitive diff/prompt material to publicly downloadable artifacts.
2. **Serial matrix of independent bounded jobs**, one for each expected chunk, `max-parallel: 1`, retaining the current per-job 20-minute timeout and existing minimum model capability/approved providers, request timeout and pool controls. No increase in concurrent provider calls, total review count or configured chunk budget. Each job must reconstruct/verify the trusted manifest against the same immutable refs (or consume private, access-controlled artifacts with their digest verified) and review exactly one chunk. Fail closed if an expected chunk cannot be reviewed or validated. No branch/PR code may supply an executable workflow or mutable model routing config.
3. **Structured result integrity:** one result per expected chunk; include chunk index, manifest digest, base and head SHA, verified reviewer verdict/findings with valid line mapping, sanitized provider metadata and model capability. Upload only with strict artifact access/retention and documented threat model. Do NOT expose prompts, full diff, tokens, credentials or redacted secrets. No partial results are sufficient for PASS.
4. **Aggregator and quality gate:** run only after all chunks terminate; recompute expected manifest and require exactly the expected contiguous indices 1..N with identical digests, no duplicates and all successful/valid results. Dedupe P0–P3 findings and require all per-chunk coverage before posting inline comments. Enforce existing severity thresholds; failed/cancelled/skipped/timeouts, missing artifacts, mismatches or provider errors must block the overall quality gate.
5. **Failure and rerun policy:** retries may repeat external calls; require separate owner approval for each new provider attempt and clearly label API usage. Do not auto-retry failed matrix jobs without budget authorization. Preserve deterministic jobs and completed evidence, but never pass using stale/different-head results.
6. **Static no-provider verification:** mock provider responses; prove exact 9-of-9 completeness, stable chunk reconstruction, fail-closed on chunk 3 cancellation, hash tampering, duplicated/missing artifacts, mismatched SHAs, any P0/P1, provider output invalidity, cross-tenant/untrusted PR injection, over-budget chunking, and selective reruns. Verify that job concurrency never exceeds 1 and that no production/PR review can pass based on incomplete coverage.
7. **Deployment boundary:** implement only on a draft APES branch; independent code review and deterministic CI before seeking owner approval to merge. Separately approve any Numerra workflow pin update and *one bounded provider review* after implementation. No change to APES PR #10 parallel prototype; do not turn on concurrency.

## Alternative requiring explicit approval

Raise the existing single `ai-review` job time budget (e.g. to 120 minutes) while preserving sequential model calls, and use existing per-chunk progress logs. This is a simpler but less resilient implementation; it increases runner occupancy and allows a stuck chunk to consume substantially more wall time. It **must not** be silently merged or enabled because it changes approved runtime/resource exposure.

## Decision requested

Authorize engineering implementation and review of the serial-per-chunk fail-closed design (no live provider execution and no merging by default), or explicitly choose a larger single-job timebox subject to separate resource and provider-budget approval. Numerra PR #11 remains draft/blocked and M5F must not be treated as shipped.
