# APES Production Security Headers Standard

## Purpose

Every APES-managed production web application must implement and verify a minimum HTTP security-header baseline. The control exists in two stages:

1. **Repository/CI verification** — APES checks application and deployment configuration for evidence that the baseline is implemented.
2. **Runtime verification** — staging/production delivery pipelines can probe the actual HTTPS response with `scripts/check-security-headers.js`.

A repository must not be considered fully verified merely because header names appear in source code. Runtime response verification is the authoritative final check.

## Required baseline

APES requires these controls for production web applications:

- `Content-Security-Policy`
- `Strict-Transport-Security`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy`
- `Permissions-Policy`
- Frame protection through either CSP `frame-ancestors` or `X-Frame-Options: DENY|SAMEORIGIN`

APES does not require deprecated `X-XSS-Protection`.

Cross-origin isolation headers such as COOP/COEP/CORP are application-specific because they can break OAuth popups, embedded content, and third-party resources. Add them when the architecture requires them rather than blindly enabling them globally.

## Policy modes

`security.headers.mode` supports:

- `required` — missing baseline controls are P1 and fail closed even when legacy 13-layer assurance remains in audit mode.
- `audit` — record the missing baseline without blocking. Use only during legacy onboarding/remediation.
- `off` — disable the control. This requires an explicit project decision and should be rare.

`security.headers.applicability` supports:

- `web` — explicitly a web application; header control always applies.
- `auto` — APES detects common web frameworks/runtime signatures.
- `non-web` — explicitly not an HTTP/web application.

The APES web-project template uses `mode: required` and `applicability: web`.

## Framework and edge handling

Security headers may be emitted by application middleware such as Helmet, by a reverse proxy such as Nginx, or by an edge/CDN layer. APES accepts repository configuration evidence for CI, but production readiness still requires a runtime probe of the actual delivered HTTPS response.

If Helmet is used, APES treats its normal CSP, HSTS, nosniff, Referrer-Policy, and frame-protection defaults as evidence unless those controls are explicitly disabled. `Permissions-Policy` must still be configured explicitly because its correct value is application-specific.

## Runtime probe

Use:

```bash
SECURITY_HEADERS_URL=https://staging.example.com node scripts/check-security-headers.js
```

The runtime probe fails if required headers are missing or materially unsafe. In particular:

- HSTS must contain `max-age` of at least 15552000 seconds.
- `X-Content-Type-Options` must equal `nosniff`.
- `Referrer-Policy` must not be `unsafe-url`.
- Frame protection must be present through CSP `frame-ancestors` or safe `X-Frame-Options`.

The probe requires HTTPS. It is intended for staging and production release gates.

## Legacy repositories

When onboarding an existing production repository:

1. set `security.assurance.mode = "audit"`;
2. set `security.headers.mode = "audit"`;
3. inventory the current posture;
4. remediate missing/weak headers;
5. verify actual staging responses;
6. switch `security.headers.mode` to `required`;
7. later switch the wider assurance mode to `enforce` after the inherited backlog is addressed.

This lets APES discover old weaknesses without immediately freezing development, while preventing a remediated project from regressing.
