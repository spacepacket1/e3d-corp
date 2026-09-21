# Phase 1 Summary

- Phase: 1
- Title: Vendor history selection and assessment validation (pure helpers)
- Provider: codex
- Model: gpt-5.4
- Completed: 2026-09-18T10:17:55-0700
- Exit status: 1

## Implementation Handoff

- Phase implemented: Phase 1 only (`lib/authority/policy.js`, new `lib/roles/riskAssess.js`, new `test/riskAssess.test.js`, targeted `test/phase5.test.js` update).
- Policy change: bumped `ACTION_POLICY_VERSION` from `2` to `3` and added `flag-payment-request` at `AUTHORITY_LEVELS.FINANCIAL_ACTION` without altering existing mappings.
- New helper module exports only:
  - `normalizeVendorId`
  - `selectVendorHistory`
  - `parseAssessmentJson`
  - `normalizeAssessment`
- Intentionally did not add or export `runRiskAssess`; that remains for Phase 2.
- `selectVendorHistory` behavior:
  - matches by exact normalized `subject.id` or string `payload.vendorId`
  - excludes the request event itself
  - requires true prior history, including same-millisecond ties via earlier file order
  - returns at most 20 newest matches, newest first, with later file order as the equal-timestamp tie-break
- `parseAssessmentJson` reuses the repo’s markdown-fence stripping pattern before strict `JSON.parse`, and rejects empty/invalid output.
- `normalizeAssessment` enforces the exact four-key schema, trims strings, accepts only `HOLD|APPROVE|CHECK`, and rejects extras, blanks, duplicates, and fabricated evidence IDs.
- Updated the stale Phase 5 assertion from `/policy v2 requires 2/` to `/policy v3 requires 2/`; no other `phase5` behavior was changed.

- Tests added in `test/riskAssess.test.js` cover:
  - verdict acceptance/normalization for `HOLD`, `APPROVE`, `CHECK`
  - empty `riskFactors` and empty `evidenceEventIds`
  - malformed JSON, extra keys, invalid verdicts, missing fields, blank risk factors, duplicate citations, fabricated evidence IDs
  - vendor-history selection through `subject.id` and `payload.vendorId`
  - unrelated vendor exclusion, request-self exclusion, same-timestamp log-order predating, newest-first 20-item bound, empty-history case
  - `flag-payment-request` resolving to authority level 3

- Verification run:
  - `node --test test/riskAssess.test.js` ✅
  - `node --test test/phase5.test.js` ✅
  - `node --check lib/roles/riskAssess.js` ✅
  - `npm install` ✅
  - `npm run check` ❌ blocked by pre-existing repo issues outside Phase 1 scope

- Observed repo-wide blockers during `npm run check`:
  - missing runtime deps in existing CLI/test paths (`@aws-sdk/client-ses` / `@smithy/core`)
  - missing external temp module `/tmp/e3d-trade/scripts/capitalMandates.js`
  - real integration tests expecting unavailable external services

## Verification
- failed (1): `npm install && npm run check`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M lib/authority/policy.js`
- ` M test/phase5.test.js`
- `?? .e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918101747/`
- `?? lib/roles/riskAssess.js`
- `?? test/riskAssess.test.js`
