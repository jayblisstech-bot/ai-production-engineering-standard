# APES — Strict $20 Cross-Provider Review Budget (Design / No Live Activation)

**Status: REFERENCE + MOCK TESTS ONLY. Do not merge or enable paid review on this design alone.**

## Requirement and fail-closed scope

For Numerra PR #11, owner authorized at most **USD $20 total provider charges** for exactly one future full APES review, covering all review chunks, provider/model retries, Gemini key rotation, and approved OpenAI/Anthropic/Gemini fallbacks. Existing APES maxChunks, maxChunkChars, 90-second request timeout, 20-minute worker timeout, and max-parallel 1 are **not** monetary controls. GitHub jobs have separate processes and cannot share an in-memory spending counter. Provider dashboards and delayed billing alerts are not a cross-provider hard cap.

The new reference module \`scripts/review-dollar-budget.js\` is intentionally **not connected to the live APES review transport or workflow**. It models the required accounting contract and throws \`APES_BUDGET_LIVE_NOT_CERTIFIED\` when asked to certify real production use.

## Enforcement trust boundary (must exist before live use)

A trusted, durable **budget gateway**, not untrusted PR code or individual GitHub runners, must own all of the following:

1. **Exclusive paid egress and credentials.** OpenAI, Anthropic and Gemini API keys live *only* in the trusted gateway's secret manager; the APES worker gets a scoped, short-lived gateway identity. Remove the raw provider-secret forwarding from the Numerra worker in the strict-budget mode. A direct HTTPS request to OpenAI/Gemini from the worker must not be capable of authorizing paid use. The gateway must authorize the exact GitHub OIDC run identity, repo, immutable base/head/pipeline refs, attempt number and approved budget grant.
2. **One authoritative atomic ledger.** Initialize one durable ledger row for \`(repo,PR,run_id,run_attempt,head_sha,base_sha,pipeline_sha,grant_id)\` with a **$20.00 / 20,000,000 micro-USD** ceiling. Each unique provider *attempt* — including Gemini retries and model fallbacks — gets an atomic reservation before gateway outbound egress. Use database row locks/serializable transactions or an equivalent proven compare-and-swap primitive. A new CI job/process cannot reset the ledger.
3. **Authoritative price and token ceilings.** Before reservation, gateway validates an allowlisted provider/model with a reviewed, unexpired price schedule and quotes worst-case *billable* input, output, thinking/reasoning, caching, hidden overhead, tool calls and per-request fees. It must enforce provider-specific maximum output and verify input bounds using a trustworthy tokenizer/provider contract, not a caller-claimed token count. Unsupported/variable/unknown price components or endpoints **fail closed**. Model catalog and price changes require a new approval. Each retry must use a new request ID and its own quote. Quotes may be conservative, rejecting affordable requests rather than risking overspend.
4. **Server-side cost reservation and reconciliation.** Commit a ceiling reservation in the shared ledger *before* transport. On verified provider usage and the applicable billable tariff, charge measured billable cost and release the remainder. When requests time out, usage is absent, or billing settlement is ambiguous, hold/charge the **full reserved ceiling** until independently reconciled; never optimistically refund. Reject duplicates across jobs and retries. Unknown costs, quote overruns or corruption require hard stop and incident investigation.
5. **Remaining-budget refusal.** The gateway refuses any further billable request whenever \`charged + reserved + new_worst_case > 20,000,000\` micro-USD. This includes failed model responses, Gemini project rotation, format retries and later chunks. When insufficient funds for remaining work, APES must fail closed (no partial-coverage PASS, no bypass). A new workflow attempt must require fresh approval; no reuse of the same grant.
6. **Invoice reconciliation.** Even a correct gateway may be unable to *guarantee third-party final invoices* if vendors can charge unbounded hidden work, asynchronous charges, changed price schedules, or post-acceptance overages. A production hard-cap claim is conditional on verified API-side billable maxima and pricing contracts. If those cannot be established for a model/provider, exclude that route. Confirm the guarantee, rather than treating estimates or provider dashboard controls as enforcement.
7. **Audit and fault injection.** Produce credential-free immutable evidence: budget-grant ID, bound review attempt, gateway software/price catalog version, preflight proof of exclusive egress, reservation/settlement events with monetary amounts, remaining budget and coverage digest. Never include prompts, private diff, provider secrets or full raw AI responses in cost artifacts. Test simultaneous requests, cancelled jobs, replay IDs, tampering, crashes, gateway outages and model-price changes. The existing P0/P1, manifest/9-of-9 coverage and security gates remain mandatory.

## Reference module boundaries

- \`parseCapUsd('20')\` -> \`20000000\` micro-USD. Monetary integers avoid floating-point rounding.
- \`ceilingMicros(catalogEntry, limits, nowMs)\` computes an upward-rounded upper quote from trusted rates and strictly positive provider-enforced token limits, rejecting missing/stale rates.
- \`BudgetLedgerReference\` simulates a single shared atomic ledger with immutable run bindings, idempotency rejection, reservations and conservative unknown-usage accounting.
- \`simulateGatewayCall\` demonstrates reservation **before** a mock transport. It contains **no** HTTP calls or real credentials.
- \`assertProductionReady()\` always fails closed. The in-memory ledger is unsuitable for live GitHub matrices. **Never call this module a deployed or verified $20 spending cap.**

## Required integration evidence and approval gates

1. Implement and deploy gateway + atomic persistent backing store in an *isolated non-production environment*. Do not use or migrate Numerra's production database or expose tenant data.
2. Adapt the APES provider clients and Gemini pool so all requests/retries can only traverse the gateway and the workflow does not forward direct paid API keys.
3. Enforce a **one-attempt** owner grant bound to the exact candidate/pipeline and a total ceiling of $20 across every enabled provider. Obtain an independent security review and mock end-to-end CI that proves dollar reservations cannot be bypassed or reset across nine separate jobs.
4. Confirm real provider-specific worst-case billable pricing/token caps and obtain gateway audit evidence before *any* paid request. If a model cannot provide deterministic upper charges, disable that model. Keep the protected-base Hermes policy freshness preflight.
5. Only then request separate explicit authorization for APES gateway rollout and controlled Numerra PR #16 integration/base synchronization, which can trigger a paid review. Verify the complete nine-chunk review and final quality gate; do not merge Numerra or deploy production automatically.

### Known Numerra blocker

Numerra PR #11 event base SHA \`81514fed7dce390810e9a8f82b3d85ef16648cca\` still resolves a Gemini-only trusted \`.apes.json\` policy. Current protected Numerra \`main\` has allowlisted OpenAI/Anthropic/Gemini. The APES merged Hermes preflight will reject the stale event base rather than spend, but a controlled PR base refresh is still needed, coordinated with the strict budget gate.
