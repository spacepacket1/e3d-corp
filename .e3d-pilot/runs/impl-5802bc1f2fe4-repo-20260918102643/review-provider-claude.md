Reviewed the diff against the spec-final.md requirements across all three phases.

**Correctness**
- `lib/authority/policy.js`: version bump to 3 and new `flag-payment-request` → `FINANCIAL_ACTION` mapping match spec; existing mappings untouched.
- `lib/roles/riskAssess.js`: `selectVendorHistory`'s predates/tie-break logic, 20-item newest-first bound, and evidence-ID allowlist all match the spec precisely. `normalizeAssessment` correctly rejects extra/missing keys, bad verdicts, blank strings, duplicate/fabricated evidence IDs.
- `runRiskAssess` correctly throws on missing `roles.risk.assess` config *before* any provider call (confirmed by the "0 calls" test), never appends a Decision/Action, and derives `proposedBy` from config rather than model output even when the model injects a bogus `model` field — verified by the provider-array test.
- CLI (`lib/cli.js`) validates all flags before `loadInstance`/event writes, matching the "validate before writing" constraint. Due-date/reference optional-field handling correctly omits the key rather than storing `undefined`.
- No action executor registered for `flag-payment-request` — confirmed by both the diff and a dedicated test.

**Regressions**
- `test/phase5.test.js` change is a single, scoped regex update (`v2`→`v3`) matching the version bump; nothing else in that file touched.
- `ACTION_POLICY` changes are additive only.

**Scope**
- All touched files are within the allowlisted set (`policy.js`, `riskAssess.js`, `cli.js`, `examples/instance.example.json`, `test/riskAssess.test.js`, `test/phase5.test.js`) plus pipeline manifest/spec artifacts. No stray edits, no new dependencies, no private/instance-specific data added.

Minor non-blocking nits (not defects): `requireTrimmedStringFlag` + `normalizeVendorId` both trim redundantly; `normalizeAssessment`'s key-count check is slightly redundant given the missing/extra checks already cover it. Neither affects correctness.

---VERDICT---
status: approved
reason: Implementation matches the negotiated spec precisely, tests cover all required paths, no regressions or scope-creep found.
