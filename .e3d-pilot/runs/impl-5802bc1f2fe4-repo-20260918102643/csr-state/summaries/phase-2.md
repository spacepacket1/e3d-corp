# Phase 2 Summary

- Phase: 2
- Title: Risk assessment orchestration (runRiskAssess)
- Provider: codex
- Model: gpt-5.4
- Completed: 2026-09-18T10:28:31-0700
- Exit status: 0

## Implementation Handoff

- Implemented Phase 2 only: added `runRiskAssess` in `lib/roles/riskAssess.js`.
- `runRiskAssess` now:
- loads file-order history with `readAllEventRecords(dataDir)`
- resolves exactly one provider from `roles["risk.assess"].provider` (array uses only the first entry)
- supports injected `llmClient` with the existing `{ text }` response shape while still resolving configured `provider` and `model`
- builds a bounded prompt with the stored request event, up to 20 newest vendor-relevant prior events, exact allowed evidence ids, and explicit `APPROVE`/`CHECK` safety instructions
- validates and normalizes the role JSON through the Phase 1 helpers before any write
- creates exactly one pending `flag-payment-request` proposal via `createProposal`
- does not append the request event, emit provider completion/failure events, decide proposals, confirm actions, or touch executors
- normalized proposal payload request fields are copied from the stored event shape and omit blank/absent `dueDate` and `reference`
- Updated `test/riskAssess.test.js` to retain Phase 1 helper coverage and add Phase 2 orchestration coverage for:
- stored request -> one pending `proposal.created`
- causation/correlation preservation
- `APPROVE` remaining advisory only with no decision/action events
- bounded vendor-history prompt inputs and exact allowed evidence ids
- invalid/ungrounded role output leaving only the stored request event
- provider/model attribution coming from config/registry, not response metadata
- missing `roles.risk.assess` config failing before any provider call
- Tests run:
- `node --check lib/roles/riskAssess.js`
- `node --test test/riskAssess.test.js`
- `npm install`
- `node --check bin/e3d-corp`
- `node --test --test-skip-pattern='real knowledge-base results|records evidence for the repo lookup|real integration returns real repos' $(find test -name '*.test.js' ! -name 'e3dTradeAcceptance.test.js')`
- Unresolved follow-up outside Phase 2:
- bare `npm run check` still fails from pre-existing workspace issues:
- `test/e3dTradeAcceptance.test.js` imports missing `/private/var/folders/.../e3d-trade/scripts/capitalMandates.js`
- real knowledge-base integration assertions in `test/phase3.test.js` and `test/phase8.test.js` currently return `unavailable`

## Verification
- passed: `npm install && node --check bin/e3d-corp && node --test --test-skip-pattern='real knowledge-base results|records evidence for the repo lookup|real integration returns real repos' $(find test -name '*.test.js' ! -name 'e3dTradeAcceptance.test.js')`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M lib/authority/policy.js`
- ` M test/phase5.test.js`
- `?? .e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918102643/`
- `?? lib/roles/riskAssess.js`
- `?? test/riskAssess.test.js`
