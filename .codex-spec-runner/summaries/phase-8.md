# Phase 8 Summary

- Phase: 8
- Title: `e3d-pilot` Handoff Contract
- Provider: claude
- Model: sonnet
- Completed: 2026-08-14 (interactive session)
- Exit status: 0

## Verified against e3d-pilot's actual current contract (not assumed)

Per the phase's explicit requirement, `e3d-pilot`'s real CLI/config contract was read before designing anything:

- `/Users/cbloom/e3d-pilot/config.schema.json` - the authoritative, current per-target-repo config schema. **Its `research_topics` field is a single free-text `string`** (`"type": "string"`), not an array, despite `docs/build-e3d-pilot.md`'s prose reading like a list of hints. Confirmed against `/Users/cbloom/e3d-pilot/examples/sample-config.json`: `"research_topics": "AI video generation, wallet-paid APIs"` - one comma-joined string.
- `bash /Users/cbloom/e3d-pilot/bin/e3d-pilot --help` - confirms the real subcommand surface (`run --repo <path> --stage <name>`, stages `discover|ideate|draft|negotiate|execute|review|publish|all`).
- `/Users/cbloom/e3d-pilot/docs/build-e3d-pilot.md` Phases 1, 3, and 4 - **the critical finding**: e3d-pilot's `discover`/`ideate` pipeline is entirely self-directed. `discover` gathers its own local facts (git log, `gh` issues/PRs, docs) plus one model call grounded by `research_topics` (a *hint* for its web-research pass, not a directive); `ideate` then has its configured provider generate 3-5 candidate ideas itself from `findings.md`, scored and ranked, with **no documented mechanism anywhere in the pipeline to inject or force-select a specific external idea**. There is no "starting objective" input contract to consume in the sense the ticket's prose implied - I did not assume one existed and built around it; I designed around what actually exists.
- Consequence for the handoff artifact's design: the only real, consumable "starting objective" surface is `.e3d-pilot/config.json`'s `research_topics` string. `lib/pilot/handoffArtifact.js` appends the Opportunity's title/description to it (additively, deduped against repeat handoffs for the same opportunity - never overwrites the target repo's existing research direction). A separate audit file under `.e3d-pilot/e3d-corp-handoffs/<opportunity-id>.md` (evidence, rationale, score, full causal chain) is also written for human/traceability purposes, but is explicitly **not** claimed to be read by e3d-pilot's own stages - only `research_topics` actually is.
- e3d-corp refuses to author a target repo's `.e3d-pilot/config.json` from scratch (throws a clear error naming the missing file) - the config's other fields (`verify` commands, `protected_paths`, provider assignment, diff ceilings) are operational decisions belonging to whoever set up `e3d-pilot` for that repo, not something e3d-corp should guess.

## Implementation Handoff

- `lib/pilot/handoffArtifact.js`: `writeHandoffArtifact({ targetRepoPath, opportunity, chain, reason })` - validates the target's `.e3d-pilot/config.json` against e3d-pilot's real required-field list, appends to `research_topics`, writes the audit markdown.
- `lib/proposals/pilotHandoff.js`: `proposePilotHandoff(dataDir, { opportunity, targetRepo, reason, proposedBy, instanceConfig })` - deterministic, no LLM role (the spec defines none for this phase, unlike Phase 7's outreach - a human decision to hand a specific opportunity to e3d-pilot against a specific repo isn't content an LLM drafts). Requires `status: "pursuing"`, derives `authorityLevel: 2` from the existing policy table (`pilot-handoff` was already in `ACTION_POLICY` since Phase 5).
- `lib/actions/pilotHandoff.js`: the real action-execution function, registered for `pilot-handoff` in `lib/cli.js` alongside Phase 7's `send-outreach`. `assertProposalAuthorized` first, then `writeHandoffArtifact`, then appends `pilot-handoff.created` with `causationId` = the approving Decision event and `correlationId` preserved from the originating chain.
- `lib/research/futcoMcp.js` / `lib/research/adapter.js`: added `listRepos` (wraps futco-mcp's real `list_repos` tool, same evidence-logging pattern as `getRepoInfo`/`searchKnowledgeBase`).
- `lib/pilot/checkShipped.js`: `checkCapabilityShipped({ dataDir, opportunityId, listRepos })` - deterministic keyword-overlap matching between the Opportunity's own words and futco-mcp's real repo listing (no LLM judgment call here at all - a keyword match is auditable/reproducible in a way a model verdict wouldn't be, and "AI suggests, code decides" has no AI role to suggest anything in this phase). Requires a prior `pilot-handoff.created` event for the opportunity (refuses otherwise); appends `capability.shipped` with `causationId` back to it only on a real match, never a false positive.
- `lib/cli.js`: `opportunities propose-handoff <id> --repo <path> --reason <reason>` and `opportunities check-shipped <id>` (was a Phase 1-6 stub, now real) - both call the same lib functions the web UI does.
- `lib/web/render.js` / `lib/web/server.js`: `/opportunities/:id` gained a "Propose e3d-pilot handoff" form (`repo`/`reason` -> `POST .../propose-handoff`) and a "Check shipped" button (`POST .../check-shipped`), both CSRF-protected, both thin calls into the same lib functions as the CLI.
- Tests: `test/phase8.test.js` (8 new tests) - artifact write/idempotency, refusal with no target config, proposal creation's `pursuing`/authority-level requirements, the action's approved/non-approved guard and event correctness, `checkCapabilityShipped`'s match/no-match/no-prior-handoff cases against fixture `list_repos` responses, a **real** `listRepos` integration test against real `futco-mcp` (same pattern Phase 3/4 already used for `getRepoInfo`/`searchKnowledgeBase`), and the phase's literal acceptance criterion: a hand-crafted `product-opportunity` marked `pursuing`, its `pilot-handoff` proposal proposed and approved entirely through real HTTP calls against the web UI, producing a well-formed artifact and a `pilot-handoff.created` event with the correct `correlationId`. All 72 tests pass (`npm test`), run directly in this session.
- One pre-existing Phase 5 test (`CLI: a hand-crafted proposal at each authority level...`) needed its level-2 fixture given a real, valid `pilot-handoff` payload (a real opportunity + a throwaway target repo with a minimal valid config) instead of an empty one - as of this phase, every level-2 action type (`send-outreach`, `pilot-handoff`) has a real registered executor, so an empty payload now correctly fails loudly instead of silently no-opping. This is the same category of fix Phase 7 needed for the same test.

## Acceptance Criteria status

- Handoff artifact shape verified against e3d-pilot's actual contract, cited above. **Done.**
- Hand-crafted `product-opportunity` -> `pursuing` -> approved `pilot-handoff` proposal via the web UI -> well-formed artifact + `pilot-handoff.created` with correct `correlationId`. **Done, tested.**
- `check-shipped` against fixture `futco-mcp` responses: match appends `capability.shipped`, no-match reports cleanly without a false event. **Done, tested.**

No real-world/human-approval acceptance bar is specified for this phase (unlike Phase 7's real-send requirement) - everything above is fully covered by automated tests, no further real-world action needed to consider Phase 8 complete.

## Verification
- passed: `npm test` (72/72), run directly in this session
- passed: `npm run check` (`node --check bin/e3d-corp && node --test`)
