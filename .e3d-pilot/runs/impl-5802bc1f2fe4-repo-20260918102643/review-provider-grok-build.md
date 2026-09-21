I'll read the full review prompt and inspect the implemented diff against the spec.I'll inspect the implementation files against the spec, focusing on helpers, CLI, policy, and tests.The Event-to-Proposal path is correct: `flag-payment-request` is authority level 3, `APPROVE` stays pending, there is no executor, CLI validation happens before any write, and invalid model output leaves the request event in the log.

**Correctness**
- `selectVendorHistory` matches vendor on `subject.id` / string `payload.vendorId`, excludes the request and later events, caps at 20, and tie-breaks same timestamps by log order.
- `runRiskAssess` takes `{ text }` from the provider, resolves `provider`/`model` from instance config, and calls `createProposal` with the specified causation/correlation and payload.
- `request submit` normalizes flags as specified and `run()` awaits it; unknown `request` subcommands print help and return nonzero.

**Tests / gaps (not merge-blocking)**
- Phase 1 helpers are only exercised through `runRiskAssess`. There are no direct tests for extra keys, blank risk factors, duplicate evidence IDs after trim, markdown-fence JSON, or same-millisecond history.
- `appendHistoryEvent` never writes the provided `id` onto the event, so the `event.id === 'unrelated-history'|'future-history'` checks are no-ops. The 20-id `deepEqual` still covers exclusion.

**Scope-creep**
- Drop `.codex-spec-runner/manifest.tsv` (machine-local temp paths) and `.e3d-pilot/runs/.../spec-final.md` from the product change.
- Implementation is over the 8-file / 900-line budget, mostly from `test/riskAssess.test.js`.

---VERDICT---
status: approved
reason: Payment-request guard matches the spec’s Event-to-Proposal contract with no executor or auto-approval regression
