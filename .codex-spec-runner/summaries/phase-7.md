# Phase 7 Summary

- Phase: 7
- Title: Pursuit: Outreach Role and Approved External Actions
- Provider: claude
- Model: sonnet
- Completed: 2026-08-14 (interactive session)
- Exit status: 0

## Implementation Handoff

- `lib/roles/communicator.js`: `runOpportunityCommunicator({ instanceConfig, dataDir, opportunity, researchAdapter, llmClient })` - refuses anything but a `pursuing` opportunity, reconstructs its causal chain, derives a recipient deterministically (never via the LLM, to avoid hallucinated addresses): a real contact email from a `lead.received` event in the chain if present, else `instanceConfig.outreach.fallbackToEmail`, else throws. Grounds the draft in the existing evidence chain plus one fresh `futco-mcp` knowledge-base lookup (when a `researchAdapter` is passed). LLM output is strict JSON `{subject, body, rationale}`, validated the same way Phase 4's `opportunity.prospect` validates its candidate JSON. Always ends in a `createProposal` call (type `send-outreach`, authority level 2 from the existing policy table) - never sends anything itself.
- `lib/actions/sendOutreach.js`: the real action-execution function, registered for `send-outreach`. Calls `assertProposalAuthorized` first (refuses non-approved proposals, wrong type/level), refuses a proposal missing `to`/`subject`/`body`, then calls an injectable `transport` (defaults to `lib/outreach/sesTransport.js`'s `sendEmailViaSes`) and appends `outreach.sent` with `causationId` = the approving Decision event and `correlationId` = the originating chain's correlationId (both threaded in via `ctx`).
- `lib/outreach/sesTransport.js`: Amazon SES via `@aws-sdk/client-ses` (this repo's first external dependency - SES's SigV4-signed API doesn't fit the "bearer token + fetch" pattern the rest of the repo uses for Tavily/futco-mcp, so a maintained SDK beat hand-rolling a signer for something the real-send acceptance bar depends on working correctly). Reads `region`/`fromEmail` from `instanceConfig.outreach` (fails closed if missing); AWS credentials come from the SDK's default provider chain (`~/.aws/credentials`), matching how this machine is already authenticated to AWS elsewhere. **User-directed choice**: asked the user how to wire a real transport (no email provider existed anywhere in this repo or its siblings); they said "use my Amazon SES, like I've done for other projects, send to support@futco.ai." Asked a follow-up for the verified from-address/region since their local `aws-cli` was broken (bad Python interpreter) and I couldn't list SES identities myself: `outreach@futco.ai` / `us-east-2`.
- `lib/actions/log.js`: `listExecutedActions(dataDir)` folds `outreach.sent` (extensible event-type list for future real actions) into the `/actions` view's rows - same fold-from-event-log pattern as Opportunities/Proposals, no second store.
- `lib/web/server.js` + `lib/web/render.js`: added `GET /actions` (observational, no decide form - approval already happened upstream at the Proposal) and an "Actions" nav link.
- `lib/decisions/decide.js`: `decideProposal`/`confirmAndExecute` gained a trailing optional `instanceConfig` parameter, threaded into the executor's `ctx` - additive/backward-compatible (existing Phase 5/6 call sites and tests didn't need to change). This is what lets `sendOutreach` reach `instanceConfig.outreach` without ctx carrying the whole config by default; every other Phase 5/6 field on ctx is unchanged.
- `lib/cli.js`: new `pursue [--instance <name>]` command - runs the communicator over every `pursuing` opportunity that doesn't already have a `send-outreach` proposal tied to its correlationId (idempotent re-runs). Also the one place `registerActionExecutor('send-outreach', sendOutreach)` happens (module-level, so both the CLI and `web` command get the real executor from a single call site).
- `lib/config.js`: validates an optional `outreach` section (`provider`/`region`/`fromEmail` required together, `fallbackToEmail` optional).
- Config: added `roles.opportunity.communicator` (provider `local`, model `$LLM_MODEL` - defaults to local Qwen per the spec, same as `opportunity.prospect`) and an `outreach` section to `examples/instance.example.json` and the real (gitignored) FutCo instance config (`region: us-east-2`, `fromEmail: outreach@futco.ai`, `fallbackToEmail: support@futco.ai`).
- Tests: `test/phase7.test.js` (13 new tests) - communicator draft/proposal shape, refusal when not `pursuing`, malformed-LLM-output refusal, markdown-fence stripping, `deriveRecipient`'s lead-email/fallback/refuse-if-neither behavior, `sendOutreach`'s pending/rejected refusal and missing-field refusal, a full `decideProposal` → real `sendOutreach` (fake transport injected) → `/actions` HTTP round trip asserting links back to the proposal and opportunity, and a CLI smoke test for `pursue` with no pursuing opportunities. Also had to fix one **pre-existing** Phase 5 CLI test that happened to create a bare `{}`-payload `send-outreach` proposal and approve it through the real CLI subprocess - before Phase 7, nothing was registered for that type so approval was a silent no-op; now that a real executor is wired, that test's level-2 fixture uses `pilot-handoff` instead (also authority level 2, but has no real executor until Phase 8), which restores its original no-op intent without weakening Phase 7's real wiring. All 64 tests pass (`npm test`), verified directly in this session (not just claimed).

## Unresolved / Follow-up - the real acceptance bar

**This phase's actual acceptance bar - "at least one real, human-approved outreach is sent for a real FutCo opportunity discovered in Phase 4, end to end... via the web UI" - is intentionally not done in this session.** Reasons, and what's needed:

- `.env` currently has only `TAVILY_API_KEY`. `LLM_BASE_URL`/`LLM_MODEL` (needed for the communicator's draft) and `E3D_CORP_WEB_USER`/`E3D_CORP_WEB_PASS` (needed to log into the web UI at all) are not set - `e3d-corp pursue`/`e3d-corp web` will refuse or fail until those are added, same gap Phase 6 already flagged for the web UI specifically.
- I don't know whether `outreach@futco.ai` is actually a verified SES identity yet in `us-east-2` (local `aws-cli` is broken - bad Python interpreter under `/opt/homebrew/Cellar/awscli/2.35.7` - so I couldn't check myself). If it isn't verified, the real send will fail at `sendEmailViaSes` with a clear SES error.
- More fundamentally: the spec's acceptance bar is a *human* clicking "approve" in a real browser after reviewing a real drafted email - that's the actual control this phase exists to prove out. Simulating that click myself via a raw HTTP request would satisfy the letter of the mechanical tests (already covered above) but not the actual point of the human-approval gate, and it also means firing one real external email under my own judgment rather than yours. I did not do that.
- **To finish the real run**: add the three missing env vars, fix or bypass the local `aws-cli` to confirm `outreach@futco.ai` is verified in SES (or verify it), then `e3d-corp opportunities decide <a-real-phase-4-opportunity-id> --status pursuing ...` or the web UI's decide form, `e3d-corp pursue`, and approve the resulting proposal in the web UI yourself. I can walk through this with you interactively once you're ready.

## Verification
- passed: `npm test` (64/64), run directly in this session
- not run: the real end-to-end SES send (see above)

## Worktree Snapshot
- ` M examples/instance.example.json`
- ` M lib/cli.js`
- ` M lib/config.js`
- ` M lib/decisions/decide.js`
- ` M lib/web/render.js`
- ` M lib/web/server.js`
- ` M package.json`
- ` M test/phase5.test.js`
- `?? lib/actions/log.js`
- `?? lib/actions/sendOutreach.js`
- `?? lib/outreach/`
- `?? lib/roles/communicator.js`
- `?? package-lock.json`
- `?? test/phase7.test.js`
