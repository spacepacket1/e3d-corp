# Governed vs. Ungoverned Experiment Readiness

Date: 2026-08-27

Phase: 8 - Governed vs. Ungoverned Experiment Readiness Report

## Status

The Phase 2-7 implementation is far enough along that the experiment design in `docs/e3d-corp-e3d-trade-stack-spec.md` is technically runnable in paper mode against a live E3D input stream. The missing items are now operational setup and experiment packaging, not core governance-path product work.

## Current Read

### CONTROL

Runnable today. `e3d-trade` already runs its existing paper pipeline with no active mandate, and the Phase 5 acceptance coverage confirms that no-mandate behavior remains unchanged.

### TREATMENT

Runnable today in paper mode. `e3d-corp` can produce an investing Opportunity, turn it into a `capital_mandate` Proposal, require human approval, submit the approved mandate to `e3d-trade`, and receive mandate-tagged outcomes back into the existing Outcome -> Experience path.

### Shared invariants already in place

- Mandates cannot bypass or relax deterministic Risk limits.
- Only an `active` mandate can influence trading.
- Revoked, suspended, expired, or merely proposed mandates do not affect behavior.
- Paper trading remains the default.
- Mandate-influenced trade records and returned outcomes carry `mandate_id` and `correlation_id`.
- Duplicate mandate submission and duplicate outcome delivery are idempotent.

## What Is Still Missing To Run The Actual Experiment

1. Two isolated `e3d-trade` runtimes for contemporaneous CONTROL and TREATMENT.
The current `e3d-trade` checkout uses repo-local `portfolio.json`, `logs/`, `reports/`, and `state/`. Running both arms from one checkout would collide on those files. The practical fix is a second isolated deployment or checkout, each pointed at the same live E3D feed but with separate local state and separate ports.

2. Real environment and auth wiring.
`e3d-corp` still needs a live instance config with `e3dTrade.baseUrl` plus either `apiKeyEnvVar` or `sessionCookieEnvVar`. `e3d-trade` still needs live E3D auth plus outcome-callback config such as `E3D_CORP_BASE_URL` and either `E3D_CORP_API_KEY` or `E3D_CORP_SESSION_COOKIE`. The webhook token on the corp side also needs to be set.

3. An explicit experiment run declaration.
Before starting, the operator still needs to freeze the exact mandate text, benchmark, evaluation window, cadence, and naming for the two paper books so the comparison is predeclared rather than improvised after results are visible.

4. A comparison procedure for the predeclared metrics.
The underlying telemetry exists across `portfolio.json`, trade logs, exported outcomes, and portfolio snapshots, but there is not yet one dedicated governed-vs-ungoverned report generator in this repo pair. That is not a blocker to running the experiment, but it is a blocker to claiming the comparison is fully push-button today.

## Non-Blockers

- No new approval system is needed.
- No new mandate schema or intake endpoint is needed.
- No new outcome-ingest path is needed.
- No live-trading enablement is needed or desired for this phase.
- No later-phase multi-agent, regime, thesis-graph, or multi-tenant work is required.

## Go / No-Go

### Is the experiment runnable against a live input stream today?

Yes, conditionally. The code path needed for CONTROL and TREATMENT exists now, but it needs two isolated paper-trading deployments and real config/secrets before it can be run safely and cleanly.

### Is anything materially missing from the product implementation?

No material product gap remains for the Phase 8 question. The remaining work is operator setup, environment wiring, and experiment packaging.

### Is this testable in days rather than weeks?

Yes. This is a GO for testability in days, not weeks, because the remaining steps are operational:

- stand up a second isolated `e3d-trade` paper instance
- point both instances at the same live E3D stream
- keep one instance mandate-free and submit one approved active mandate to the other
- configure the callback/auth environment
- predeclare the benchmark and evaluation window

### Is it a GO to start the experiment immediately from the current single checkout with no additional setup?

No. That is a NO-GO until the twin-runtime isolation and environment wiring are in place.

## Bottom Line

The governed-vs-ungoverned experiment is implementation-ready but not operator-ready by default. The architecture, guardrails, traceability, and acceptance coverage are already present. What remains is the smallest possible launch setup for two isolated paper books and a predeclared comparison procedure, which is a days-scale task.
