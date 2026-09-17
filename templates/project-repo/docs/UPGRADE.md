# Upgrading APES in this repository

APES upgrades are deliberate security-control changes.

1. Review the target central APES release notes and diff.
2. Update the vendored project files from that release, including `AI_AGENT_INSTRUCTIONS.md`, `docs/AI_REVIEW_POLICY.md`, and template changes.
3. Update `VERSION`.
4. Update `.github/workflows/ai-review.yml` so both the reusable-workflow ref and `pipeline_ref` point to the same reviewed 40-character commit SHA. Production callers should not revert to a mutable branch or moving tag.
5. Reconcile `.apes.json` against the new release schema. Do not carry forward deprecated/unknown keys. For APES v1.2+, review Hermes routing mode, approved providers, model catalog overrides, and Gemini pool settings explicitly.
6. Run the central APES regression suite and the project's own required checks.
7. Merge the upgrade as a dedicated security-control PR with human review.

Do not point production repositories at mutable `main`, `master`, `latest`, or an unreviewed release ref.

The reusable workflow still accepts an exact `vX.Y.Z` tag for controlled upgrade/bootstrap scenarios, but the production template pins the reviewed runtime by full commit SHA.
