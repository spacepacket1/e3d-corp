# U.S. Financial Stress Monitor — `e3d-corp` Implementation Spec (Phase Group 2 of 3)

Status: Ready for `codex-spec-runner` — revised after round-2 review (codex, grok, Devin) against real code. Fixed: `proposedBy.model: null` (rejected by real schema validation), missing `lib/cli.js`/`lib/actions/log.js` registration touch-points, a reviewer-correction storage design that didn't account for how `decideProposal`'s event payload actually works, wire-schema casing, and a wrong idempotency-precedent choice (the lead webhook, unlike the trade-outcome webhook, isn't actually idempotent).
Depends on: the `e3d` phase group's webhook-intake contract — specifically `e3d`'s dashboard/release endpoints, not the OpenAI-facing webhook internal to that repo (a prior draft of this line named the wrong endpoint) — and this repo's own new inbound/outbound routes below.
Feeds: nothing downstream in this product — this phase group is the human-approval gate; `e3d` owns everything that happens after approval.
Master design doc: `us-financial-stress-monitor-spec.md` in this repo's `docs/` — this file is the actionable slice scoped to this repo.

## Context (read this before starting any phase)

This repo already runs the exact kind of thing this product needs for its human-approval step: an event-sourced Proposal → Decision → Action spine with a versioned authority-level policy (`lib/authority/policy.js`), and it **already receives external webhook events from other repos** — two working examples exist right now: `POST /webhooks/e3d-applied-lead` (from `e3d-applied`) and `POST /webhooks/e3d-trade-outcomes` (from `e3d-trade`), both in `lib/web/server.js`, both bearer-token authenticated via `checkBearerToken`/`loadLeadWebhookToken`/`loadTradeOutcomeWebhookToken` in `lib/web/auth.js`.

**Correction per round-2 review** — these two examples are *not* equivalent, and picking the wrong one to copy matters: the lead route calls `recordLeadReceived` (`lib/event-sources/e3dApplied.js`), which has **no idempotency check at all**; the trade-outcomes route calls `recordTradeOutcomeReturn` (`lib/outcomes/tradeReturn.js`), which **is idempotent**, looked up by `outcome_id`. This new intake needs real idempotency (`e3d`'s pipeline retries the call on failure), so **model it on the trade-outcomes route's pattern, not the lead route's** — the "bespoke webhook, bearer-token, `MAX_BODY_BYTES`-limited" shape is common to both and fine to copy from either; the idempotency-check logic specifically must come from `recordTradeOutcomeReturn`.

This phase group adds a **third** such intake — from `e3d`'s Financial Stress Monitor pipeline — following that corrected pattern, not inventing a new one. Do not build a generic "webhook framework"; match the existing bespoke-per-source shape, since that's this repo's established convention.

The product context: `e3d`'s three-stage AI pipeline (OpenAI deep-research, Grok inference-critic, Claude narrative) evaluates U.S. financial-system stress and, on a material change, calls into this repo to create a Proposal. Chris reviews it — seeing all three stages' output, able to correct the score, not just approve/reject — and, because publishing an alert/newsletter is irreversible once sent, approval requires the **two-step flow this repo's policy already mandates for level-4 actions**: `decideProposal` then a separate `confirmAndExecute`. On confirmation, this repo calls back into `e3d` with a signed release request.

---

## Phase 1 — Webhook Intake & Proposal Creation (`E3D-FSM-201`)

**Wire contract**: the incoming JSON body from `e3d` uses **snake_case field names** (`run_id`, `event_id`, `material_change`, `score_before`, `score_after`, etc.), matching the master spec's §10 schema and the `e3d` phase group's own pinned wire contract. Every field reference below uses that casing consistently — do not mix in camelCase, which a prior draft of this spec did in a way that would have produced broken field lookups at runtime (round-2 review caught this).

**Auth**: add `loadStressEvaluationWebhookToken(config)` to `lib/web/auth.js`, mirroring `loadTradeOutcomeWebhookToken` exactly (reads `config.stressEvaluationWebhook.tokenEnvVar` from `process.env`). Add the corresponding config key to `lib/config.js`, alongside the existing `tradeOutcomeWebhook` entry (verified at `lib/config.js:293-297`).

**Event-source module**: `lib/event-sources/financialStressMonitor.js`. **Idempotency modeled on `recordTradeOutcomeReturn` (`lib/outcomes/tradeReturn.js`), not `recordLeadReceived`** — round-2 review found the lead-intake precedent this phase originally cited has no idempotency check at all, while the trade-outcomes precedent does (looked up by its own id). A `recordStressEvaluationReceived(dataDir, submission, {causationId, correlationId})` function:
1. Validates the payload is a plain object (reject arrays/null, matching `recordLeadReceived`'s guard).
2. Looks up whether an event already exists for `submission.run_id` (query the event log the same way `recordTradeOutcomeReturn` checks for an existing `outcome_id`) — if so, return the existing record without appending a duplicate.
3. Otherwise appends:

```js
appendEvent(dataDir, {
  type: 'financial-stress-evaluation.received',
  source: 'e3d.financial-stress-pipeline',
  subject: { type: 'financial-stress-run', id: submission.run_id },
  payload: submission, // the full pipeline payload from e3d, incl. pipeline.stage1_research/stage2_crosscheck/stage3_narrative — snake_case throughout
  causationId,
  correlationId
});
```

**Route**: in `lib/web/server.js`, add `POST /webhooks/e3d-financial-stress-evaluation` (renamed per round-2 review to match this repo's own naming convention — both existing routes are prefixed with the source repo's name, `e3d-applied-lead`/`e3d-trade-outcomes`; the `e3d` phase group's outbound call is pinned to this exact path) alongside the existing two webhook routes, same request-body-size guard via `MAX_BODY_BYTES`/`readRequestBody`, same bearer-token check pattern:

```js
if (req.method === 'POST' && req.url.split('?')[0] === '/webhooks/e3d-financial-stress-evaluation') {
  const expectedToken = loadStressEvaluationWebhookToken(config);
  // ... checkBearerToken, parse JSON body, call recordStressEvaluationReceived
}
```

**Proposal creation**: only when `submission.material_change === true`. Call `createProposal(dataDir, { type: 'publish-stress-change', payload: submission, proposedBy: { role: 'financial-stress-pipeline', provider: 'e3d', model: 'financial-stress-pipeline-v1' }, correlationId, instanceConfig })` (from `lib/proposals/create.js` — this function already exists and needs no changes; it derives `authorityLevel` from the policy table, which Phase 2 below extends). **Corrected per round-2 review**: `proposedBy.model` must be a non-empty string — `validateProposalInput` (`lib/proposals/schema.js`) rejects `null`, confirmed directly against the real validation code. Use a real, meaningful string like `'financial-stress-pipeline-v1'`, not a placeholder. If `material_change === false`, the event is still appended (step 3 above happens regardless) but no Proposal is created — matches the existing rule that authority levels 0–1 never generate one.

**Acceptance**: a POST with a valid bearer token and a `material_change: true` payload creates exactly one Proposal, visible via the existing `listProposals`/web UI. The same payload POSTed twice (same `run_id`) creates exactly one event and one Proposal (verify the idempotency check actually prevents the second `appendEvent` call, not just that `createProposal` happens to be skipped downstream). A `material_change: false` payload creates an event but no Proposal. An invalid/missing bearer token returns 401 without touching the event log, matching the existing two webhook routes' behavior.

---

## Phase 2 — Authority Policy & Reviewer Correction (`E3D-FSM-202`)

**Policy entry**: add `'publish-stress-change': AUTHORITY_LEVELS.IRREVERSIBLE_ACTION` to `lib/authority/policy.js`'s `ACTION_POLICY` map, alongside `mark-deal-closed`. Bump `ACTION_POLICY_VERSION`. This is deliberate, not a default: an approved stress alert fans out to email/newsletter, which cannot be recalled once sent — it belongs at the same tier as the existing irreversible actions, not at `send-outreach`'s reversible tier. **Real regression to fix while making this change, found in round-2 review**: `test/phase5.test.js:123` asserts a literal `/policy v2 requires 2/` error message tied to the current `ACTION_POLICY_VERSION`. Bumping the version breaks this test's expectation — update it to match the new version string as part of this phase, don't leave it red.

**Reviewer correction — redesigned per round-2 review**: a prior draft of this phase assumed `decideProposal` could carry arbitrary structured correction data on the Decision record. **Verified against the real code this isn't true**: `decideProposal`'s (`lib/decisions/decide.js`) `proposal.approved`/`proposal.rejected` event payload is a fixed shape (`{decisionId, subjectType, subjectId, decision, reason, decidedBy, decidedAt, via}`) with no room for extra fields, and `confirmAndExecute` deliberately accepts no `reason`/extra data at all (by design — "the deliberation already happened at approval"). Extending `decide.js`'s shared payload shape risks affecting every other proposal type that already depends on it (`send-outreach`, `pilot-handoff`, `capital_mandate`) — too risky for what should be a narrow, product-specific addition. Instead:

1. Before calling `decideProposal`, the web handler (or CLI command) for a `publish-stress-change` Proposal specifically appends a **separate** event, `financial-stress-correction.submitted`, carrying `{ proposalId, finalScore, finalLiquidityResponse, finalRegime, note }` (camelCase is fine here — this is a local `e3d-corp` event, not the cross-repo wire payload) with `causationId` pointing at the Proposal's `proposal.created` event and `correlationId` matching the Proposal's own.
2. `decideProposal` then proceeds completely unmodified — no changes to `lib/decisions/decide.js` at all.
3. Phase 3's Action executor (`publishStressChange.js`), when it fires on `confirmAndExecute`, explicitly queries the event log (`queryEvents`) for the most recent `financial-stress-correction.submitted` event matching this `proposalId`. If present, its values become the release payload's `final_*` fields; if absent, the executor falls back to Stage 1's (or the Proposal's stored) draft score.

This keeps every change scoped to new, product-specific code — nothing shared touches other proposal types.

**Display**: the Proposal detail view should show a triage summary by default (agree/disagree at a glance) with the full three-stage breakdown (Stage 1 score+evidence, Stage 2 score+flags, Stage 2b if it ran, Stage 3 narrative) available on expand — not the full JSON dumped inline for every routine, low-disagreement evaluation. This is a UX decision for `lib/web/render.js`'s template, not a new architectural component.

**Acceptance, corrected per round-2 review** (a prior draft mischaracterized an existing guard): `lib/authority/policy.js`'s test suite (extend the existing one) confirms `publish-stress-change` resolves to level 4. **The real existing guard in `lib/proposals/create.js` throws for levels 0–1 only** (proposals below `EXTERNAL_ACTION`), not "below 4" as a prior draft claimed — don't write a test asserting behavior that doesn't exist. The level-4 two-step (`decideProposal` then separate `confirmAndExecute`) is **already covered generically** by existing test coverage (`test/phase5.test.js:270`) — no new test needed for that mechanism itself, only for this specific action type's policy entry and its correction/release flow. A `financial-stress-correction.submitted` event is visible and correctly attributed to its Proposal via `causationId`/`correlationId`.

---

## Phase 3 — Two-Step Approval, Release Call, and Reject Callback (`E3D-FSM-203`)

**Two-step flow**: level 4 already requires `decideProposal` (approve) followed by a separate `confirmAndExecute` call (`lib/decisions/decide.js`) before any Action fires — this repo's existing machinery already enforces this. This phase's job includes real registration work a prior draft missed (found in round-2 review, verified directly against the code):

1. **Register the executor** in `lib/cli.js`, alongside the existing `registerActionExecutor('send-outreach', sendOutreach)` / `registerActionExecutor('pilot-handoff', pilotHandoff)` / `registerActionExecutor('capital_mandate', submitCapitalMandate)` calls (confirmed at `lib/cli.js:31-33`) — add `registerActionExecutor('publish-stress-change', publishStressChange)`. Without this, `confirmAndExecute` throws when it looks up the executor (`lib/decisions/decide.js`), and the web UI (which imports `lib/cli.js`) won't have it wired either.
2. **Register the fired-event type** in `lib/actions/log.js`'s `ACTION_FIRED_EVENT_TYPES` array (confirmed real at `lib/actions/log.js:7`, currently `['outreach.sent', 'pilot-handoff.created', 'capital-mandate.submitted']`) — add the new event type this executor appends (e.g. `'financial-stress-change.published'`) and a corresponding `summarizeAction` case, matching the existing pattern for the other three. Without this, a fired release doesn't show up correctly on the Actions page.

**Action executor**: `lib/actions/publishStressChange.js` (new file, alongside the existing action executors listed above). Fires on `confirmAndExecute` for a `publish-stress-change` Proposal. Queries for a `financial-stress-correction.submitted` event (Phase 2) to get any reviewer-corrected `final_*` values, falling back to the Proposal's own draft score if none was submitted, and calls `e3d`'s release endpoint with the snake_case wire payload (`run_id`, `event_id`, `final_score`, `final_liquidity_response`, `final_regime`, `reviewer_correction_note`).

**Client**: `lib/e3d/client.js` (new — a sibling to the existing `lib/trade/client.js`, modeled directly on it): `x-api-key`/`x-e3d-api-key` header auth via env var (matching `lib/trade/client.js`'s `authHeaders` pattern exactly), **including its existing `Idempotency-Key` header** (confirmed real at `lib/trade/client.js`, a prior draft of this spec omitted mentioning it — don't drop it, reuse it), configurable base URL/path (`e3d.baseUrl`, default path `/webhooks/e3d-financial-stress-evaluation/release` — matching the `e3d` phase group's renamed route), retry on 5xx with the same backoff/timeout/max-attempts defaults `lib/trade/client.js` already uses (`DEFAULT_TIMEOUT_MS=5000`, `DEFAULT_MAX_ATTEMPTS=3`), idempotent by construction since the payload carries `run_id`/`event_id` and `e3d`'s Phase 4 receiver is built to no-op on a repeat. **Labeling correction per round-2 review**: this is API-key-header authentication, not cryptographically signed/HMAC request-signing — call it that plainly in code/comments rather than "signed," which overstates what it actually is. If the master spec's replay-protection goal (§21) matters enough to act on now rather than defer, a cheap addition is a timestamp header plus a short validity window checked server-side — worth doing, but scope it explicitly as an addition to the API-key pattern, not a different mechanism.

**Reject callback, new in this revision** (round-2 review: "one reject stalls the pipeline" — `e3d`'s scheduler refuses a new evaluation cycle while any prior one is still `pending`, and nothing previously told `e3d` about a rejection). `decideProposal` does not fire any executor on rejection (its executor-firing branch only runs `if (decision === 'approved' ...)`), so this is new, narrowly-scoped call-site logic, not a change to `decide.js`: in the web handler (`POST /proposals/:id/decide`) and the CLI reject command, **after** a successful `decideProposal(..., 'rejected', ...)` call for a `publish-stress-change` proposal specifically, make a direct call to `lib/e3d/client.js`'s reject endpoint (`POST /webhooks/e3d-financial-stress-evaluation/reject`, same auth/idempotency shape as the release call) carrying `run_id` and the rejection reason. Keep this check scoped to this one proposal type at the call site (`if (proposal.type === 'publish-stress-change') { ... }`), not built into the generic Decision machinery, matching this repo's existing convention of keeping type-specific side effects out of shared code (e.g. the existing `outreachAlreadySentForOpportunity` guard in `decide.js` is the one exception to that convention, and it's a safety check, not a side-effect dispatch — don't follow it as precedent for adding more type-specific branches into shared code).

**Action logging**: the fired Action, its request payload, and the response (or final failure after retries) get logged via the existing `lib/actions/log.js` mechanism (extended per item 2 above) — no new logging infrastructure beyond that one registration.

**Acceptance**: approving then confirming a test `publish-stress-change` Proposal results in exactly one outbound release call to a stubbed `e3d` endpoint, with retry-on-5xx verified against a stub that fails twice then succeeds, and the fired event appears correctly summarized on the Actions page (verifying the `lib/actions/log.js` registration actually took effect, not just that the executor ran). Rejecting a test Proposal results in exactly one outbound reject call. Attempting `confirmAndExecute` without a prior `decideProposal` approval is rejected by the existing, already-tested guard — no new test needed for that generic mechanism (`test/phase5.test.js:270` already covers it).

---

## Open items to flag back to Chris before/during this phase group

**Resolved 2026-09-03**: timestamp/replay protection on the `e3d-corp` ↔ `e3d` calls — confirmed deferred to V1, keep the current API-key pattern.

Still open:

- Confirm the exact shape of `instanceConfig`'s webhook-token config keys (`stressEvaluationWebhook.tokenEnvVar`) matches how `leadWebhook`/`tradeOutcomeWebhook` are actually wired in the deployed config, not just the code — check the real (gitignored) instance config, not just the schema.
- Reviewer-correction UX (Phase 2) is scoped minimally here (a separate correction event plus a plain form) — if Chris wants a richer review experience later, that's a V1 UI investment, not blocking for V0.
