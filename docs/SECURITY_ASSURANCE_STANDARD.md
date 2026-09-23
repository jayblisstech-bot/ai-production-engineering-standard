# APES 13-Layer Production Security Assurance Standard

## Purpose

APES security assurance is a defense-in-depth confirmation layer. It complements secure coding, deterministic tests, SAST/dependency/secret checks, human review, and authorized external penetration testing. It does not replace any of them.

For legacy repositories, start with `security.assurance.mode = "audit"`. Findings are recorded without blocking CI. After remediation and evidence completion, switch to `"enforce"` so configured severities fail closed.

## Status semantics

Each layer uses one of:

- **FAIL** — a deterministic blocking anti-pattern was detected.
- **PARTIAL** — repository evidence exists and/or non-blocking findings remain; full operational verification is incomplete.
- **UNKNOWN** — the available repository/evidence cannot establish the control.
- **NOT APPLICABLE** — only when applicability is explicitly justified.
- **PASS** — reserved for evidence-aware verification that can prove required controls. The static scanner deliberately does not manufacture PASS.

## The 13 layers

1. Identity & Session Security
2. Authorization & Tenant Isolation
3. Application, API & Client Security
4. Data Protection, Privacy & Residency
5. Database, Financial & Transaction Integrity
6. Integrations, Webhooks & External APIs
7. Dependencies & Software Supply Chain
8. Infrastructure, Hosting & Network Security
9. CI/CD & Release Security
10. Logging, Monitoring, Detection & Auditability
11. Availability, Performance & Resilience
12. Backup, Disaster Recovery & Incident Response
13. AI/LLM Security & Governance

## Audit lifecycle

Production assurance follows:

`audit → remediation → internal verification → authorized external penetration test → remediation → re-audit → evidence package`.

An APES internal audit must never be represented as an independent penetration test.

## Evidence rule

Claims such as encryption at rest, backup recoverability, hosting region, data residency, monitoring, incident response readiness, or penetration-test cadence require authoritative operational evidence. Code presence alone is insufficient.

## Modes

### off

No repository-wide assurance scan is run.

### audit

The full static repository scan runs and generates a report. P0/P1 findings are surfaced but do not fail the workflow. This is the correct onboarding mode for inherited/legacy projects.

### enforce

The full scan runs and exits non-zero when a severity listed in `security.assurance.failOnSeverities` is found.

## Initial deterministic anti-pattern coverage

The first v1.3 implementation detects high-signal patterns including:

- hard-coded authentication/session secret fallbacks;
- browser localStorage token storage;
- unsafe raw database execution;
- disabled TLS certificate verification;
- credentialed CORS fail-open/wildcard behavior;
- webhook signature verification that becomes optional when verification material is absent;
- directly static-served upload directories;
- embedded private keys;
- raw HTML rendering that requires sanitization review.

This list is intentionally conservative and should grow through regression cases discovered in real repositories.

## Legacy remediation

Audit mode does not silently modify application code. The generated report becomes the remediation backlog. Fixes then flow through ordinary APES PR review so APES can confirm the vulnerability is removed and regression coverage exists.
