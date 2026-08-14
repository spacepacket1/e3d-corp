# Phase 10 Summary

- Phase: 10
- Title: Evaluation and Metrics
- Provider: claude
- Model: sonnet
- Completed: 2026-08-14 (interactive session)
- Exit status: 0

## A deliberate deviation from the spec's literal text (documented, not silent)

The spec's prose reads as if every metric is computed "from experience.jsonl." Taken literally, that would badly undercount reality: Phase 9 only appends an Experience snapshot to `experience.jsonl` for a *meaningfully-completed* chain (one that reached a Decision or Outcome) - most real opportunities at this stage haven't gotten that far yet. Gating "opportunities discovered," acceptance rate, proposal rejection rate, and the outreach funnel behind that would silently misreport the system's real state (directly contradicting this phase's own acceptance bar: "must accurately reflect that rather than presenting placeholder/demo numbers").

`lib/evaluation/metrics.js` instead computes:
- **Directly from `events.jsonl`** (via the same fold functions/`queryEvents` Opportunities/Proposals/Actions already use): opportunities discovered (count, by type), opportunity acceptance rate, proposal rejection rate, and the outreach funnel (sent/replied/meetings-booked/deals-won, all keyed off real `outreach.sent` action events and outcome events sharing the same `correlationId`) - reality-preserving even when nothing has reached an Outcome yet.
- **From `experience.jsonl`** (`lib/experience/store.js`'s new `listLatestExperience`, deduped to the latest snapshot per `correlationId` - a chain can accumulate several snapshots over time as more outcomes are recorded, and treating each snapshot as a separate data point would double-count): cost/latency by role+model, and cost-per-useful-opportunity - the two metrics where "one fully assembled chain" is genuinely the right unit, since they need `role`/`model`/`costEstimate` fields that only exist on an assembled Experience record.

## Implementation Handoff

- `lib/experience/store.js`: added `listLatestExperience(dataDir)` (latest snapshot per `correlationId`) alongside the existing append-only `listExperience`/`readExperience`.
- `lib/evaluation/metrics.js`: `computeMetrics(dataDir, { since })` returns `{ since, opportunitiesDiscovered, opportunityAcceptance, proposalRejection, outreach, revenueAttributable, usefulOpportunityCount, costPerUsefulOpportunity, latencyByRoleModel, costByRoleModel }`. `costPerUsefulOpportunity`/`costByRoleModel` are always `null`/`{}` today - no LLM call anywhere in this codebase records token usage or cost (same finding as Phase 9), so there is nothing real to divide by; reported honestly as "no data" rather than a fabricated `0`. `POSITIVE_OUTCOME_TYPES` (a documented judgment call, not spec-literal: `meeting.booked`, `proposal.accepted`, `deal.won`, `invoice.paid`, `customer.adopted`, `capability.shipped`) defines "useful" for cost-per-useful-opportunity. `formatMetricsReport(metrics)` renders the human-readable text both the CLI and (in spirit) the web view share the same data for. No "training readiness" signal is computed or exposed anywhere, per the spec's explicit Non-Goal.
- `lib/cli.js`: `evaluate report [--since <date>]` (was a Phase 1-6 stub, now real).
- `lib/web/render.js` / `server.js`: new `GET /metrics` (read-only, `?since=` query param), nav link added.
- Tests: `test/phase10.test.js` (6 new tests) - a fully hand-computed fixture (3 opportunities across 2 types, 2 reviewed pursuing/1 no-value, 1 proposal approved+fired/1 rejected, 2 outreach.sent, one chain running the full `prospect.replied -> meeting.booked -> deal.won -> invoice.paid($500)` outcome sequence) checked against every metric this phase defines, matching the phase's literal acceptance criterion; a `--since` filtering test; a report-format test confirming "no data" is rendered honestly rather than `0%`; CLI and web parity against the same fixture; and the phase's other literal acceptance criterion - `evaluate report` run directly against the real FutCo instance's actual data, asserting real structural correctness (real counts, valid rate bounds or explicit `null`, no `NaN`, no crash) rather than fabricated placeholder numbers. All 85 tests pass (`npm test`), run directly in this session. This last test is read-only against the real instance - it does not mutate `.e3d-corp/instance/futco/`.

## Acceptance Criteria status

- Fixture `experience.jsonl`/event data with a known mix of outcomes: `evaluate report` matches hand-computed expected values for every metric, `/metrics` renders the same values. **Done, tested.**
- Running `evaluate report` against real (even sparse) FutCo data produces a real, non-fabricated report. **Done, tested directly against the real instance in this session** - real opportunity count (6, from Phase 4's real discovery runs) with everything downstream of that (acceptance/rejection/outreach/revenue/cost) honestly reporting zero or `n/a (no data)`, since no real proposal has been decided, no real outreach sent, and no real outcome recorded yet.

## Verification
- passed: `npm test` (85/85), run directly in this session
- passed: `npm run check`
