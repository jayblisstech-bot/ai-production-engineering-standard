# APES — Strict $10 Cross-Provider Review Budget (Design / No Live Activation)

**Status: REFERENCE + MOCK TESTS ONLY. Do not merge or enable paid review on this design alone.**

## Owner-approved reduced cap: $10 (supersedes previous $20)

The latest owner instruction reduces the **whole-review combined cap to USD $10**. No earlier $20 authorization remains valid for the next attempt. A mock cap is not a live spending guarantee.

## Reusable APES core: repository-scoped grants and pluggable storage

**Platform rule:** The central APES budget controller serves all repositories. A repository supplies its reviewed policy; the trusted APES gateway enforces a distinct owner-authorized spending grant for each immutable review run. There is no mandatory Supabase dependency and no need to create a new budget service for each repository.

- Core contract is implemented in gateway/budget-service.js, with **no storage SDK import**. It accepts a trusted adapter supporting snapshot(grantId, binding), reserve({grantId,binding,requestId,quoteMicros}), and settle({grantId,binding,requestId,verified,actualMicros}). Calls may be synchronous in tests; production adapters may be asynchronous only after the service is explicitly adapted and retested for awaited atomic operations. Never silently substitute a non-atomic adapter.
- Immutable run binding includes **repository (canonical lowercase owner/repo), PR number, run ID, attempt number, exact candidate head SHA, trusted base SHA, and pinned APES pipeline SHA**. The store must reject a grant access unless all fields match the authorized grant. Grant IDs must be globally unique or scoped by a trusted tenant namespace. Each paid attempt must use a fresh authorization.
- Trusted grant policy independently fixes **allowed provider/model routes per repo/PR/grant**. Hermes' routing preferences do not authorize a provider excluded by that grant. A request with a different repository, PR or model is rejected *before* an atomic reservation or provider operation.
- Model-specific prices and token maxima are **gateway-owned**, not taken from PR headers, request bodies or untrusted source changes. The mock service computes a conservative quote and reserves the full amount before invoking its injected fake transport. Incomplete usage charges the whole reservation; duplicate request IDs never re-enter transport.
- gateway/sqlite-budget-store.js is a **Node 24+ local demonstration adapter** with WAL and atomic BEGIN IMMEDIATE transactions. gateway/budget-service.js is also tested against a separate in-memory adapter with no database import. This proves interface portability, not hosted production reliability or invoice enforcement.
- gateway/mock-local-gateway.js is a loopback-only HTTP adapter for synthetic provider names; it uses the generic service and approved mock grant policies. Its test bearer token does not authenticate real GitHub job identity. Do not expose it on the internet or populate it with production provider credentials.

### Production adapter acceptance criteria

A production adapter (PostgreSQL, another transactional SQL engine, or an equivalent durable service) must provide atomic cross-process reservations, persistent run/grant identity, replay resistance, operational isolation, auditable ledger events, secure backup and crash recovery, and authorization that prevents untrusted repository code from creating grants or lowering its price estimates. Provider credentials must be removed from GitHub AI workers and restricted to a hardened hosted gateway with verified GitHub OIDC identity and exclusive paid egress. Real provider-specific upper charges must be verifiably bounded; unknown charges/models fail closed. These are **not implemented by the current mock PR**.

**Budget examples, not new spending authorizations:** Numerra's current *one-run* maximum remains **$10**. A different repo may receive another approved limit for another run; neither grant can spend the other's allowance. No extra provider spending is authorized by this architecture change.

## Requirement and fail-closed scope

For Numerra PR #11, owner authorized at most **USD $10 total provider charges** for exactly one future full APES review, covering all review chunks, provider/model retries, Gemini key rotation, and approved OpenAI/Anthropic/Gemini fallbacks. Existing APES maxChunks, maxChunkChars, 90-second request timeout, 20-minute worker timeout, and max-parallel 1 are **not** monetary controls. GitHub jobs have separate processes and cannot share an in-memory spending counter. Provider dashboards and delayed billing alerts are not a cross-provider hard cap.

The new reference module \`scripts/review-dollar-budget.js\` is intentionally **not connected to the live APES review transport or workflow**. It models the required accounting contract and throws \`APES_BUDGET_LIVE_NOT_CERTIFIED\` when asked to certify real production use.

## Enforcement trust boundary (must exist before live use)

A trusted, durable **budget gateway**, not untrusted PR code or individual GitHub runners, must own all of the following:

1. **Exclusive paid egress and credentials.** OpenAI, Anthropic and Gemini API keys live *only* in the trusted gateway's secret manager; the APES worker gets a scoped, short-lived gateway identity. Remove the raw provider-secret forwarding from the Numerra worker in the strict-budget mode. A direct HTTPS request to OpenAI/Gemini from the worker must not be capable of authorizing paid use. The gateway must authorize the exact GitHub OIDC run identity, repo, immutable base/head/pipeline refs, attempt number and approved budget grant.
2. **One authoritative atomic ledger.** Initialize one durable ledger row for \`(repo,PR,run_id,run_attempt,head_sha,base_sha,pipeline_sha,grant_id)\` with a **$10.00 / 10,000,000 micro-USD** ceiling. Each unique provider *attempt* — including Gemini retries and model fallbacks — gets an atomic reservation before gateway outbound egress. Use database row locks/serializable transactions or an equivalent proven compare-and-swap primitive. A new CI job/process cannot reset the ledger.
3. **Authoritative price and token ceilings.** Before reservation, gateway validates an allowlisted provider/model with a reviewed, unexpired price schedule and quotes worst-case *billable* input, output, thinking/reasoning, caching, hidden overhead, tool calls and per-request fees. It must enforce provider-specific maximum output and verify input bounds using a trustworthy tokenizer/provider contract, not a caller-claimed token count. Unsupported/variable/unknown price components or endpoints **fail closed**. Model catalog and price changes require a new approval. Each retry must use a new request ID and its own quote. Quotes may be conservative, rejecting affordable requests rather than risking overspend.
4. **Server-side cost reservation and reconciliation.** Commit a ceiling reservation in the shared ledger *before* transport. On verified provider usage and the applicable billable tariff, charge measured billable cost and release the remainder. When requests time out, usage is absent, or billing settlement is ambiguous, hold/charge the **full reserved ceiling** until independently reconciled; never optimistically refund. Reject duplicates across jobs and retries. Unknown costs, quote overruns or corruption require hard stop and incident investigation.
5. **Remaining-budget refusal.** The gateway refuses any further billable request whenever \`charged + reserved + new_worst_case > 10,000,000\` micro-USD. This includes failed model responses, Gemini project rotation, format retries and later chunks. When insufficient funds for remaining work, APES must fail closed (no partial-coverage PASS, no bypass). A new workflow attempt must require fresh approval; no reuse of the same grant.
6. **Invoice reconciliation.** Even a correct gateway may be unable to *guarantee third-party final invoices* if vendors can charge unbounded hidden work, asynchronous charges, changed price schedules, or post-acceptance overages. A production hard-cap claim is conditional on verified API-side billable maxima and pricing contracts. If those cannot be established for a model/provider, exclude that route. Confirm the guarantee, rather than treating estimates or provider dashboard controls as enforcement.
7. **Audit and fault injection.** Produce credential-free immutable evidence: budget-grant ID, bound review attempt, gateway software/price catalog version, preflight proof of exclusive egress, reservation/settlement events with monetary amounts, remaining budget and coverage digest. Never include prompts, private diff, provider secrets or full raw AI responses in cost artifacts. Test simultaneous requests, cancelled jobs, replay IDs, tampering, crashes, gateway outages and model-price changes. The existing P0/P1, manifest/9-of-9 coverage and security gates remain mandatory.

## Reference module boundaries

- \`parseCapUsd('20')\` -> \`20000000\` micro-USD. Monetary integers avoid floating-point rounding.
- \`ceilingMicros(catalogEntry, limits, nowMs)\` computes an upward-rounded upper quote from trusted rates and strictly positive provider-enforced token limits, rejecting missing/stale rates.
- \`BudgetLedgerReference\` simulates a single shared atomic ledger with immutable run bindings, idempotency rejection, reservations and conservative unknown-usage accounting.
- \`simulateGatewayCall\` demonstrates reservation **before** a mock transport. It contains **no** HTTP calls or real credentials.
- \`assertProductionReady()\` always fails closed. The in-memory ledger is unsuitable for live GitHub matrices. **Never call this module a deployed or verified $10 spending cap.**


## Isolated SQLite and local mock gateway evidence

This PR additionally includes three **mock-only / Node 24+** files:

- \`gateway/sqlite-budget-store.js\` persists a bounded grant and each provider-attempt reservation in an SQLite file. Transactions use WAL, FULL synchronous mode and \`BEGIN IMMEDIATE\` so concurrent local gateway processes cannot each reuse the same $10 balance. The authorized binding includes exact immutable review run, attempt, candidate head, trusted base and APES release SHA. Unknown charges consume the entire reservation. Replayed IDs cannot issue another request.
- \`gateway/mock-local-gateway.js\` is a **loopback-only** HTTP simulator. It requires an explicit mock flag and a test bearer token. It accepts only artificial model names (\`mock-openai\`, \`mock-claude\`, \`mock-gemini\`) and uses one hardcoded *example* pricing schedule for fake replies; it makes **zero paid/external provider calls**. Incoming caller price, quote and token estimates are ignored.
- \`tests/durable-budget-gateway.test.js\` and \`tests/mock-local-gateway.test.js\` verify shared SQLite reservations across different processes, cross-provider simulated HTTP traffic, race conditions, grant/run binding, authorization failures, retries and simulated provider failure.

**Operational limitation:** This local simulator is **not a production trusted gateway**. SQLite persistence alone does not provide GitHub OIDC authorization, isolated vendor-secret custody, exclusive provider egress, real model API adapters, token enforcement, verified provider tariffs, vendor invoice reconciliation, durable gateway hosting/availability, or an authenticated administrative grant issuer. Node 24 is needed for the isolated SQLite module; the existing APES Node 20 review runners have not been changed. Do not forward production provider keys into the simulator or merge/use this as proof of a live $10 vendor-charge ceiling.

**Owner's $10 grant is not created by this PR.** No live review may start until the production requirements in this document are independently verified and approved.

## Required integration evidence and approval gates

1. Implement and deploy gateway + atomic persistent backing store in an *isolated non-production environment*. Do not use or migrate Numerra's production database or expose tenant data.
2. Adapt the APES provider clients and Gemini pool so all requests/retries can only traverse the gateway and the workflow does not forward direct paid API keys.
3. Enforce a **one-attempt** owner grant bound to the exact candidate/pipeline and a total ceiling of $10 across every enabled provider. Obtain an independent security review and mock end-to-end CI that proves dollar reservations cannot be bypassed or reset across nine separate jobs.
4. Confirm real provider-specific worst-case billable pricing/token caps and obtain gateway audit evidence before *any* paid request. If a model cannot provide deterministic upper charges, disable that model. Keep the protected-base Hermes policy freshness preflight.
5. Only then request separate explicit authorization for APES gateway rollout and controlled Numerra PR #16 integration/base synchronization, which can trigger a paid review. Verify the complete nine-chunk review and final quality gate; do not merge Numerra or deploy production automatically.

### Known Numerra blocker

Numerra PR #11 event base SHA \`81514fed7dce390810e9a8f82b3d85ef16648cca\` still resolves a Gemini-only trusted \`.apes.json\` policy. Current protected Numerra \`main\` has allowlisted OpenAI/Anthropic/Gemini. The APES merged Hermes preflight will reject the stale event base rather than spend, but a controlled PR base refresh is still needed, coordinated with the strict budget gate.
