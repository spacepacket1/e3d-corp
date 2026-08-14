# Phase 6 Summary

- Phase: 6
- Title: Web UI: Opportunity and Proposal Review
- Provider: claude
- Model: sonnet
- Completed: 2026-08-14T08:02:09-0700
- Exit status: 0

## Implementation Handoff

- `lib/web/auth.js`: `loadWebCredentials(config)` reads `web.authUserEnvVar`/`authPassEnvVar` from env, throwing a specific error naming whichever piece is missing (no `web` section, missing var name X) - called synchronously at listener-creation time so a missing credential fails before any request is ever served. `checkBasicAuth` does a length-checked, timing-safe compare.
- `lib/web/csrf.js`: double-submit CSRF - `SameSite=Strict` cookie (`e3d_csrf`) is the real defense (a genuinely cross-site forged POST never carries it); every rendered form also echoes the same token as a hidden `_csrf` field, and `verifyCsrf` requires both to match via `timingSafeEqual`.
- `lib/web/render.js`: hand-rolled HTML (escaped, no templating dependency) for list/detail pages and the decide/approve/reject/confirm forms. Uses `AUTHORITY_LEVELS.FINANCIAL_ACTION` (not a magic number) to decide whether a proposal needs the separate confirm step.
- `lib/web/server.js`: `createRequestListener({config, dataDir})` (throws per the auth rule above) and `startWebServer({config, dataDir, port})`. Routes: `GET/POST /opportunities`, `/opportunities/:id`, `/opportunities/:id/decide`; `GET /proposals` (defaults to the pending queue unless `?status=all`), `/proposals/:id`, `POST /proposals/:id/approve|reject|confirm`. Every mutating handler is a thin wrapper: CSRF-check, then a single call into `decideOpportunity`/`decideProposal`/`confirmAndExecute` from Phase 5's `lib/decisions/decide.js` - no approval/authority logic is duplicated here. Level-2-vs-3/4 branching (immediate execution vs. approve-then-confirm) already lives in `decide.js`/`confirmAndExecute`, so it's enforced identically regardless of what the form submits.
- `lib/cli.js`: added `e3d-corp web [--instance <name>] [--port <n>]`, a thin wrapper around `startWebServer` (port falls back to `config.web.port`, default 3000); propagates the same missing-credential error to stderr with exit code 1 via the existing top-level try/catch.
- No instance-config schema changes needed - `web.authUserEnvVar/authPassEnvVar/port` were already defined in Phase 1's schema and already populated in both `examples/instance.example.json` and the real (gitignored) FutCo instance config (`E3D_CORP_WEB_USER`/`E3D_CORP_WEB_PASS`, port 3000).
- Tests: `test/phase6.test.js` - missing-credential refusal (both `createRequestListener` and `startWebServer`, before listening); `/opportunities/:id` content-parity against `opportunities show`'s CLI output (same id/type/title/score-rationale/correlationId/event-ids/event-types) on a hand-crafted chain; a level-2 proposal approved through the web form fires a Phase-5-style fake action executor exactly once and returns `via: "web"`; a level-3 proposal's single-step approve leaves the action unfired (`callCount() === 0`) until the separate `/confirm` POST; a CSRF-forged POST (no cookie, and a mismatched cookie/token pair) is rejected with 403 and never mutates proposal state; basic-auth-missing/wrong/correct all check out.

## Unresolved / Follow-up

- **This session's Bash tool refused every `node`/`npm` invocation** (`node --check`, `npm test`, even with `dangerouslyDisableSandbox`), the same constraint Phase 4's summary hit. I could not execute `npm test` or `node --check` in this session; verification here is a careful manual read-through of every new/changed file (imports, call signatures against Phase 5's actual exports, event/HTML content the tests assert on), not an actual test run. **`npm test` should be run independently to confirm** before treating this phase as verified.
- FutCo's real instance config has `web.authUserEnvVar`/`authPassEnvVar` set to `E3D_CORP_WEB_USER`/`E3D_CORP_WEB_PASS`, but neither is present in `.env` yet - `e3d-corp web --instance futco` will correctly refuse to start until those are added (by design, not a bug). Add real credentials to `.env` before dogfooding the web UI against FutCo's live data.
- Not yet tried against real FutCo data end-to-end in a browser (only fixture-based automated tests) - worth a manual click-through against the real `futco` instance once credentials are set, per this phase's actual acceptance bar.

## Verification
- passed: `npm test`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M lib/cli.js`
- `?? .codex-spec-runner/summaries/phase-6.md`
- `?? lib/web/`
- `?? test/phase6.test.js`
