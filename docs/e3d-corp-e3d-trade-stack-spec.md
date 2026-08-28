# Proposal: `e3d-corp` ↔ `e3d-trade` Synergy — Minimal Viable Governance Layer

## Status

This is the fourth pass on this proposal, and it's meant to be the last one before this goes to Codex Spec Runner.

1. The original version specified a full multi-agent investment committee, a thesis graph, regime classification, and a six-phase rollout — before anything had been shown to work. A critical second-opinion review (Fable) concluded the core instinct was good but the scope was premature architecture, and it was cut to a from-scratch MVP.
2. That cut-down version still assumed `e3d-corp` and `e3d-trade` were close to blank slates. A pass over the actual FutCo/E3D ecosystem showed that was wrong — both repos are already substantially built, and most of what the MVP needed already exists somewhere in the stack. That pass replaced "build an MVP" with "wire together what's already there."
3. This pass (incorporating a second independent review, from ChatGPT with long-running context on this project) is a surgical tightening for implementation-readiness: explicit experiment design, mandate lifecycle semantics, service-contract semantics, end-to-end causal traceability, and machine-checkable acceptance tests. **No Phase 2+ architecture comes back in this pass.** The scope stays exactly as small as the previous version — this just closes the ambiguity gaps that would otherwise get resolved arbitrarily mid-implementation.

The original full vision is still preserved at the bottom as a **Future / Phase 2+ appendix**, unchanged.

## The Idea

I want to connect the FutCo instance of `e3d-corp` and `e3d-trade` in some meaningful way that produces real synergy between them, rather than having them be two disconnected repos. The shape I keep coming back to:

> **`e3d-corp` decides what FutCo wants to accomplish with its capital. `e3d-trade` decides how to implement that in markets.**

This sits on top of a stack that's been built for a long time: **`e3d.ai` (the `spacepacket` hub) already provides Stories, Theses, Token Intelligence, and Transactions** as first-class objects. `e3d-corp` and `e3d-trade` are the newer, higher layer sitting on top of that foundation — not a replacement for it, and not something that needs to reinvent it.

## Existing Foundations (verified 2026-08-27, via the FutCo/E3D knowledge base + a direct read of `e3d-corp`)

Treat the specifics below as a strong starting map, not gospel — the knowledge-base entry for `e3d-trade` was last reviewed 2026-08-06, and `e3d-corp` isn't in that knowledge base at all, so both get a fresh direct-code check in the Preflight phase below before anything is built. Directionally, this is what exists:

**`e3d` (`spacepacket` / e3d.ai)** — the foundation. Stories (on-chain narrative/wallet-behavior/token-flow signals), Theses (active investment theses, exposed as their own API surface), Token Intelligence, and Transactions. Both other repos already talk to it independently. Not part of this proposal's scope — it stays exactly as-is.

**`e3d-trade`** (`e3d-agent-trading-floor`) — already a live agentic trading pipeline, not a placeholder:
- Five agents — Scout (discovery only), Harvest (exit monitoring only), Risk (hard-limit gatekeeper: `reject`/`wait`/`reduce_size`/`paper_trade`/`approve_for_executor`), Executor (validates/paper-trades, never originates), Manager (orchestrates, inline in `pipeline.js`) — running a continuous cycle, default every 5 minutes.
- Guiding principle already in place: **"AI suggests, code decides."** Agents only ever produce structured JSON; deterministic pipeline code validates and executes.
- Already story-anchored: zero on-chain story activity excludes a token regardless of volume/price. Already pulls Stories, candidates, theses, and token prices directly from the E3D API, via an existing session-authenticated client (`e3dAuthClient.js`).
- Already paper-trades by default (`live_execution_allowed` is a code-level flag, not a prompt). This *is* the shadow portfolio the MVP wanted.
- Already has a risk engine, execution simulator, evidence packets, promotion gates, custody controls, an audit trail, and reconciliation (`scripts/`).
- Already runs its own service surface: `server.js` is a dashboard/API + WebSocket server. This is the natural place a mandate-intake endpoint would live.
- What it does **not** have: any notion of an external governing mandate. It is currently fully self-directed — nothing above it sets portfolio-level objectives, capital allocation, or risk posture. That's the actual gap this proposal fills.

**`e3d-corp`** — also not a placeholder. A general-purpose, company-agnostic, event-sourced runtime built on seven durable primitives: **Event → Opportunity → Proposal → Decision → Action → Outcome → Experience**. Every state transition is an append-only event; the event log is hash-chained (tamper-evident) with external anchoring already implemented. Models never mutate state directly — they return structured JSON against a schema, and deterministic code owns every transition and every side effect. Anything consequential is gated behind an explicit human-approval Decision, enforced inside the action functions themselves.
- This **is** the mandate/approval/decision-ledger/outcome-tracking mechanism the earlier MVP tried to design from scratch — already built, already more rigorous (hash-chained, replayable via `causationId`/`correlationId` from originating signal to measured outcome).
- Currently instantiated for a different domain (prospect-quality filtering / business development), not investing. Nothing about the runtime is investing-specific yet.

**Ecosystem-wide integration convention, already established and worth following rather than reinventing**: repos in this stack do not import each other's source. Integration happens over a shared API (or shared database), never a direct runtime import — a hard rule stated explicitly for `e3d-maps` ↔ `e3d-trade`, and the general philosophy across the stack. `e3d-trade` already runs as its own always-on service (Node pipeline + dashboard/API + Mongo + ClickHouse). Given that, **the `e3d-corp` ↔ `e3d-trade` boundary is a real, minimal API call from the start, not an in-process merge.**

## Core Question

> **Can a new `e3d-corp` role turn E3D's existing Theses/Stories into a structured capital mandate, run it through `e3d-corp`'s existing human-approval gate, and have `e3d-trade`'s existing pipeline act on it in a way that's measurably better-calibrated, better risk-adjusted, or materially safer than `e3d-trade` operating on its own?**

The test isn't "can we build a governance loop" — most of the pieces already exist. It's whether adding a governance layer on top of an already-working trading floor actually improves its behavior, or is just process overhead on a system that already does its own discovery, risk-gating, and paper-trading fine. Section "Governed vs. Ungoverned Experiment" below makes that question a precise, predeclared experimental design rather than a vague aspiration.

## Architectural Principle

> **`e3d-corp` allocates authority. `e3d-trade` exercises only the authority delegated to it.**

Concretely, this maps onto `e3d-corp`'s existing primitives instead of inventing a parallel object model:

| Original concept | Maps to `e3d-corp` primitive |
|---|---|
| Investment thesis / market read | **Opportunity** (produced by a new investing-specific role, using E3D Theses/Stories as evidence) |
| Capital mandate | **Proposal** (a new proposal type, `capital_mandate`) |
| Human approval | **Decision** — already generic, already gated, nothing new to build |
| Handing the mandate to `e3d-trade` | **Action** — already generic; a mandate handoff is exactly this category of action, same as sending outreach or touching money |
| Trade/portfolio results | **Outcome** — already generic, needs `e3d-trade` to report results back in a shape `e3d-corp` can ingest |
| Calibration over time | **Experience** — already generic, already designed to feed back into the next cycle |

Two hard invariants govern every interaction across this boundary:

> **Precedence rule: a `capital_mandate` may further constrain `e3d-trade` — it may never weaken, relax, or bypass `e3d-trade`'s existing deterministic hard-risk rules.** Risk stays sovereign at the execution layer. A mandate can only narrow what Risk already allows, never widen it, and cannot be used as a channel to override a rejected trade.

> **No active mandate → `e3d-trade` behaves exactly as it does today, unmodified.** This is the clean control baseline the experiment in the next section depends on. The intake integration must be strictly additive: absence of a mandate must be indistinguishable from this feature not existing at all.

## `capital_mandate` Lifecycle

The mandate needs enough identity and lifecycle state to behave safely across two independently-deployed services — this is a real cross-service object, not an in-memory value.

```text
mandate_id          deterministic, stable identifier — submission is idempotent on this
version              schema version of this mandate payload
owner                e.g. "futco"
status               proposed | approved | active | completed | expired | revoked | suspended
created_at
approved_at
effective_at
expires_at
revoked_at
correlation_id       ties back to the originating e3d-corp Decision/Action, carried through everything downstream
proposal_id          e3d-corp Proposal this mandate originated from
decision_id          e3d-corp Decision that approved it
thesis_refs[]        E3D Thesis object id(s) this mandate is grounded in
story_refs[]         E3D Story object id(s) this mandate is grounded in
objective
constraints
preferences
horizon
confidence
invalidation
```

Lifecycle:

```text
proposed → approved → active → completed | expired | revoked | suspended
```

Only a mandate in `active` status may influence `e3d-trade`. `e3d-trade` must actively check current status on every cycle it consults an active mandate — not just check for presence once — so `expired`/`revoked`/`suspended`/`completed` mandates stop influencing behavior going forward without requiring any retroactive change to trades already made under them.

## Governed vs. Ungoverned Experiment

The core question needs a predeclared experimental design, not a metric chosen after the fact.

```text
CONTROL
  Current e3d-trade behavior, unmodified.
  No active capital mandate.
  Paper portfolio.

TREATMENT
  Same e3d-trade version.
  Same market / E3D input stream.
  Same starting portfolio / NAV.
  Plus one approved, active e3d-corp capital_mandate.
  Paper portfolio.
```

Run CONTROL and TREATMENT **contemporaneously against the same input stream** wherever practical — not sequential time periods — so the comparison isn't confounded by different market conditions.

Predeclare the comparison metrics before the run starts. At minimum:
- total return
- benchmark-relative return
- max drawdown
- volatility
- Sharpe / Sortino, if enough observations exist to make them meaningful
- turnover
- rejected-risk events
- exposure / concentration
- confidence calibration
- mandate compliance (did TREATMENT actually stay inside the mandate's stated constraints)

**The question being tested is not "did we make money."** It's:

> Did adding corporate intent/governance improve the behavior of the trading system relative to the exact same system without it?

## Service Contract

The `e3d-corp` ↔ `e3d-trade` boundary is a real service call. Keep it minimal, but resolve these explicitly rather than leaving them to be improvised mid-implementation:

- **Endpoint / message shape**: a mandate-submission endpoint on `e3d-trade`'s existing `server.js` API surface, accepting the `capital_mandate` payload above; a corresponding outcome-delivery endpoint (or callback) on `e3d-corp`'s side.
- **Auth**: reuse whatever session/auth mechanism `e3d-trade` and `e3d-corp` already use for their existing E3D API calls (e.g. the pattern in `e3dAuthClient.js`) rather than inventing a new auth scheme for this one integration.
- **Schema / version**: every mandate payload carries `version`. `e3d-trade` rejects a payload whose version it doesn't recognize rather than guessing at forward/backward compatibility.
- **Acknowledgement**: mandate submission returns a synchronous accept/reject plus the mandate's current status. `e3d-corp` should never have to infer whether `e3d-trade` received a mandate.
- **Idempotency**: resubmitting the same `mandate_id` with an identical payload is a no-op that returns current state. Resubmitting the same `mandate_id` with a *different* payload is a conflict, not a silent overwrite — mandate changes go through the replacement path below, not a mutating resubmission.
- **Retries**: `e3d-corp` retries submission on timeout/5xx; idempotency on `mandate_id` makes retries safe.
- **Timeout/error behavior**: if `e3d-corp` times out without a confirmed acknowledgement, the mandate stays `proposed` (not `active`) until an ack is actually received — never assume delivery succeeded.
- **Mandate replacement/update**: a change to an active mandate is a new mandate (new `mandate_id`) that revokes the old one, not an in-place mutation. This keeps the audit trail honest.
- **Mandate revocation**: an explicit revoke call. `e3d-trade` stops honoring the mandate going forward; past trades made while it was active are not retroactively altered.
- **Outcome delivery**: `e3d-trade` posts results back to `e3d-corp` keyed by `mandate_id` + `correlation_id`.
- **Duplicate outcome handling**: outcome delivery is idempotent on an outcome id — redelivery must not create a duplicate `Outcome`.

Do not build out more distributed-systems infrastructure than this needs. A deterministic `mandate_id`, idempotent submission, and an explicit status check are enough to remove the ambiguous cases (e.g. "`e3d-corp` timed out submitting a mandate — did `e3d-trade` receive it?").

## Causal Traceability

One of the highest-value outputs of this whole experiment is being able to start from a single E3D Thesis or Story and trace all the way through to what it caused and what happened as a result:

```text
E3D Thesis/Story
    ↓
e3d-corp Event
    ↓
Opportunity
    ↓
Proposal
    ↓
Decision
    ↓
Action
    ↓
capital_mandate
    ↓
e3d-trade Scout/Risk/Executor
    ↓
paper trade / portfolio change
    ↓
execution result
    ↓
e3d-corp Outcome
    ↓
Experience
```

Concretely: `capital_mandate` carries `thesis_refs[]`/`story_refs[]`/`proposal_id`/`decision_id`/`correlation_id` (per the lifecycle section above). Any `e3d-trade` evidence/audit record for a trade influenced by an active mandate must carry that mandate's `mandate_id` and `correlation_id`. The `Outcome`/`Experience` `e3d-trade` reports back must carry the same `correlation_id`, so it lands on the originating `e3d-corp` Decision — not just on "some mandate," but the specific chain of reasoning that produced it.

## MVP Scope — What's New vs. What's Reused

**Reused, unchanged, nothing to build:**
- `e3d.ai` Stories/Theses feeds (both repos already consume this)
- `e3d-trade`'s Scout/Harvest/Risk/Executor/Manager pipeline
- `e3d-trade`'s paper-trading-by-default execution
- `e3d-trade`'s existing risk engine, evidence packets, audit trail, reconciliation
- `e3d-corp`'s Event log (hash-chained, append-only) — this *is* the decision ledger
- `e3d-corp`'s human-approval Decision gate
- `e3d-corp`'s Outcome/Experience primitives — this *is* the calibration mechanism

**New — the only things this proposal needs to build:**
1. Investing-specific Opportunity scorer role in `e3d-corp` (reads E3D Theses/Stories + market state → structured investment Opportunity: view, confidence, invalidation condition).
2. `capital_mandate` Proposal type in `e3d-corp`, per the lifecycle section, flowing through the existing Proposal → Decision (human-gated) → Action pipeline unmodified.
3. Approved-mandate Action in `e3d-corp`: submits the mandate to `e3d-trade` over the service contract above. Gated exactly like any other consequential action.
4. `e3d-trade` mandate intake/constraint integration: accept an active mandate, check its status every cycle, let it bias Scout's discovery and add a portfolio-level constraint layer strictly on top of Risk's existing checks (never relaxing them).
5. `e3d-trade` outcome-return path: report execution/portfolio results back to `e3d-corp`, keyed by `mandate_id`/`correlation_id`, becoming an `Outcome` that feeds `Experience`.
6. Tests necessary to prove the contract and invariants — see Acceptance Tests below.

**Not needed, because they already exist:** a new mandate-approval mechanism, a new shadow portfolio, a new risk-check engine, a new decision ledger, a new audit trail.

**Autonomy levels — kept, cheap, map onto `e3d-corp`'s existing authority-level concept:**

```text
LEVEL 0  Research only
LEVEL 1  Generate mandate proposals
LEVEL 2  Generate complete mandate + risk-adjusted plan
LEVEL 3  e3d-trade executes (paper) after human approval   <- start here
```

Levels 4–5 (real capital, no per-mandate human approval) are deferred until this loop shows calibrated signal.

## Acceptance Tests

These turn the architectural invariants above into machine-checkable criteria. All of them must pass before this is considered done:

1. An unapproved (`proposed`) mandate can never affect `e3d-trade` behavior.
2. A malformed mandate payload is rejected, not partially applied.
3. An expired, revoked, or suspended mandate cannot influence trading, even if it was previously active.
4. Duplicate submission of the same `mandate_id` with the same payload is idempotent — no duplicate mandates, no duplicate side effects.
5. A mandate cannot relax an existing deterministic Risk limit — attempting to do so is rejected or clamped to the existing limit, never honored.
6. With no active mandate, `e3d-trade`'s behavior is measurably unchanged from its current (pre-integration) behavior.
7. An approved, active mandate can demonstrably bias Scout's discovery or constrain Risk's decisions in a controlled test fixture.
8. `e3d-trade`'s evidence/audit records for mandate-influenced trades carry the originating `mandate_id` and `correlation_id`.
9. Execution results are successfully returned to the originating `e3d-corp` Action/Decision as an `Outcome`.
10. Duplicate outcome delivery does not create duplicate `Outcome` records.
11. Paper trading remains the default; this work does not enable live execution as a side effect.
12. Historical Decisions, mandates, and outcomes are immutable after their outcomes are known — no retroactive edits.

## Explicitly Deferred (see appendix)

Not because they're bad ideas — because none of them can be evaluated until the loop above is running and shows real signal. Do not implement any of the following in this pass:

- Multi-agent investment committee beyond the single Opportunity-scoring role
- Probabilistic regime classifier
- Machine-readable thesis graph with falsification tracking
- Broad performance-attribution platform (by agent / signal / asset / strategy / regime / confidence bucket)
- `e3d-trade` serving multiple capital-owner `e3d-corp` instances (multi-tenancy)
- Autonomy levels 4–5
- Any outside-capital / hedge-fund/ fund infrastructure

## Execution Notes (`codex-spec-runner`)

This spec runs via `codex-spec-runner` with:

```bash
ROOT_DIR=/Users/mini/e3d-corp
ADD_DIRS="/Users/mini/e3d-trade"
```

`e3d-corp` is the primary target repo (`ROOT_DIR`); `e3d-trade` is reachable read/write via the added directory for the phases that touch it. Every phase below re-reads this whole file (`runner:read`) so the sections above — Existing Foundations, Architectural Principle, `capital_mandate` Lifecycle, Governed vs. Ungoverned Experiment, Service Contract, Causal Traceability, Acceptance Tests, Constraints — stay in scope regardless of the runner's per-phase extraction boundary. When a phase's work belongs in `e3d-trade`, write there explicitly via the added directory, not inside `e3d-corp`.

## Phase 1 - Preflight and Verification

<!-- runner:model=high -->
<!-- runner:read=docs/e3d-corp-e3d-trade-stack-spec.md -->

Inspect the actual current code in both repos and confirm or correct every claim in "Existing Foundations" above: `e3d-trade`'s Scout/Harvest/Risk/Executor/Manager pipeline, its risk engine, evidence packets, audit trail, reconciliation scripts, and `server.js` API surface; `e3d-corp`'s Event/Opportunity/Proposal/Decision/Action/Outcome/Experience implementation and its human-approval gating.

Pay specific attention to `e3d-trade`'s `scripts/e3dActionOutcomeExport.js` and `scripts/portfolioSnapshotWriter.js` (both present in its `package.json`) — these names suggest partial existing infrastructure for exactly the kind of Action/Outcome reporting Phase 6 needs. Determine what they actually do and whether they can be reused or extended instead of rebuilt.

Write findings to `docs/e3d-corp-e3d-trade-preflight-findings.md` in `e3d-corp`: confirmed / needs-correction / not-found for each claim in "Existing Foundations," plus an explicit go/no-go recommendation for Phases 2–8.

**If a material assumption in this document is false in a way that blocks the plan** — e.g. the risk engine can't cleanly accept an external constraint layer, or `e3d-corp`'s Action gating doesn't fit a cross-service call — stop here, do not proceed to later phases, and make that the headline of the findings doc. Do not code around it and do not silently reinterpret the spec to route around the blocker.

## Phase 2 - Investing Opportunity Scorer (`e3d-corp`)

<!-- runner:read=docs/e3d-corp-e3d-trade-stack-spec.md -->
<!-- runner:verify=npm test -->

Add a new `e3d-corp` role, structured like the existing prospect-scoring role, that reads E3D Theses/Stories plus current market state and produces a structured investment `Opportunity` (view, confidence, invalidation condition) — MVP Scope item 1. Follow `e3d-corp`'s existing pattern exactly: the role returns structured JSON against a schema; it never mutates state directly. New domain only — no committee, no debate structure (see "Explicitly Deferred").

## Phase 3 - `capital_mandate` Proposal Type (`e3d-corp`)

<!-- runner:model=high -->
<!-- runner:read=docs/e3d-corp-e3d-trade-stack-spec.md -->
<!-- runner:verify=npm test -->

Add the `capital_mandate` Proposal type with the full field set and lifecycle (`proposed → approved → active → completed | expired | revoked | suspended`) from "`capital_mandate` Lifecycle" above. Wire it through the existing Proposal → Decision (human-gated) → Action pipeline unmodified — no new approval mechanism. Enforce the precedence-rule invariant at the schema/validation level where possible: a mandate's `constraints` can only ever tighten, never signal a relaxation downstream.

## Phase 4 - Approved-Mandate Action and Service Client (`e3d-corp`)

<!-- runner:model=high -->
<!-- runner:read=docs/e3d-corp-e3d-trade-stack-spec.md -->
<!-- runner:verify=npm test -->

Add the `e3d-corp` Action that submits an approved, active `capital_mandate` to `e3d-trade`, implementing the client side of "Service Contract" above: idempotent submission keyed on `mandate_id`, synchronous ack handling, retry-on-timeout without assuming delivery, and replace-not-mutate semantics for updates. Gate this exactly like any other consequential `e3d-corp` action — reuse the existing human-approval Decision gate, build nothing new for approval itself.

## Phase 5 - `e3d-trade` Mandate Intake and Constraint Integration

<!-- runner:model=high -->
<!-- runner:read=docs/e3d-corp-e3d-trade-stack-spec.md -->
<!-- runner:verify=npm test -->

In `e3d-trade`, add the server side of the mandate-submission endpoint on the existing `server.js` API surface, plus the intake integration: accept a `capital_mandate`, validate it, and check its status on every pipeline cycle it's consulted — not just once at submission. An `active` mandate may bias Scout's discovery and add a portfolio-level constraint layer strictly on top of Risk's existing hard limits; it must never relax or bypass an existing Risk limit — validate this explicitly, rejecting or clamping any mandate constraint that would loosen an existing rule. With no active mandate, `e3d-trade`'s behavior must be unchanged from today — verify this explicitly (e.g. a no-mandate fixture run diffed against pre-change baseline behavior). Any evidence/audit record for a mandate-influenced trade must carry that mandate's `mandate_id` and `correlation_id`, per "Causal Traceability" above.

## Phase 6 - `e3d-trade` Outcome-Return Path

<!-- runner:read=docs/e3d-corp-e3d-trade-stack-spec.md -->
<!-- runner:verify=npm test -->

Add the outcome-reporting path from `e3d-trade` back to `e3d-corp`: execution/portfolio results for mandate-influenced trades post back keyed by `mandate_id` and `correlation_id`, idempotent on an outcome id so redelivery never creates a duplicate `Outcome`. If Phase 1 found `scripts/e3dActionOutcomeExport.js` and/or `scripts/portfolioSnapshotWriter.js` already do adjacent work, extend them rather than duplicating. On the `e3d-corp` side, land these as `Outcome` records feeding the existing `Experience` primitive.

## Phase 7 - Acceptance Tests

<!-- runner:model=high -->
<!-- runner:read=docs/e3d-corp-e3d-trade-stack-spec.md -->
<!-- runner:verify=npm test -->

Implement automated tests, in the appropriate repo(s), proving each of the twelve invariants in "Acceptance Tests" above. All twelve must pass. Where one can't practically be tested with current fixtures, say so explicitly in the phase handoff rather than silently skipping it.

## Phase 8 - Governed vs. Ungoverned Experiment Readiness Report

<!-- runner:read=docs/e3d-corp-e3d-trade-stack-spec.md -->

Write `docs/e3d-corp-e3d-trade-experiment-readiness.md` in `e3d-corp`: is the CONTROL/TREATMENT setup in "Governed vs. Ungoverned Experiment" actually runnable against a live input stream today; what, if anything, is still missing to run it; and an explicit go/no-go read on whether it's testable in days rather than weeks. Do not start the experiment itself — this phase is a readiness assessment only.

Across all phases: do not treat "design the interface" as a stopping point once code supports proceeding to real implementation, and do not implement past a Phase 1 verification failure — stop and surface it instead.

## Constraints

Do not:
- duplicate functionality that already exists in either repo (this is the main risk now — re-read the reuse map before writing new code)
- add a direct runtime import between `e3d-corp` and `e3d-trade`; integrate over the service contract above, per existing ecosystem convention
- give trading agents unlimited authority
- allow an LLM to bypass a deterministic risk or authority check
- allow a `capital_mandate` to weaken, relax, or bypass an existing Risk limit
- allow either system to change a historical decision, mandate, or outcome after it's known
- optimize only for raw returns (calibration and risk-adjusted return matter more than raw upside)
- build around outside investors
- assume the macro thesis in the appendix is true
- encode my opinions as ground truth
- implement any item on the Explicitly Deferred list

Prefer:
- reuse over rewriting — the default answer to "do we need to build X" should be "check if `e3d-corp` or `e3d-trade` already has it" first
- deterministic enforcement of hard limits, with Risk sovereign at the execution layer
- explicit authority delegation (mandate in, proposal out), with full lifecycle state
- the existing append-only, hash-chained event history as the source of truth for decisions
- human approval for anything consequential
- the smallest version that produces a real, predeclared test

## Success Criteria for Moving Beyond This Spec

Only revisit the deferred items once the Governed vs. Ungoverned Experiment has run for a real evaluation window (think a quarter, not a week) and the predeclared metrics show:

- confidence calibration that's meaningfully better than random
- risk-adjusted return that beats the chosen benchmark
- TREATMENT outperforming or being materially safer than CONTROL on the predeclared metric set — otherwise the governance layer is just overhead

If it can't clear that bar, the answer isn't more agents — it's questioning whether the governance layer adds anything over `e3d-trade`'s existing self-directed operation.

---

## Appendix: Original Full Vision (deferred, not being built now)

This is the original proposal in full, kept for reference. Nothing here should be built until the experiment above has run and cleared the success criteria.

### Investment Thesis

FutCo could operate a proprietary AI + Digital Asset Macro strategy spanning: Bitcoin, Ethereum, XRP, crypto infrastructure, stablecoins, AI companies, semiconductors, GPUs, hyperscalers, data centers, nuclear power, natural gas, grid infrastructure, Bitcoin mining, Treasury markets, rates, monetary/fiscal policy, dollar liquidity, gold, credit conditions, and regulation — treated as one interconnected macro system.

Note from the review: this framing is closer to the dominant institutional macro narrative of the current era ("AI capex → power demand → nuclear/gas, crypto as parallel liquidity/settlement rail") than to a distinctive, proprietary edge. Breadth of coverage isn't the same as an edge. Any Phase 2 version of this should sharpen toward a specific, falsifiable, non-consensus claim rather than reasoning across everything macro-adjacent.

### Multi-Agent Investment Committee

Macro Agent, Crypto Agent, On-Chain Agent, AI/Compute Agent, Energy Agent, Policy Agent, Risk Agent (veto power), Contrarian/Devil's-Advocate Agent, CIO/Portfolio Committee Agent — each tracking a domain, debating, and producing a structured recommendation.

Note from the review: there's no strong evidence that role-played LLM "committees" produce better-calibrated forecasts than one model arguing both sides of its own thesis — especially the Contrarian Agent, which shares the same weights, the same context, and the same underlying priors as everything it's meant to challenge, and so is likely to produce contrarian-*flavored* text rather than genuinely independent adversarial pressure. Treat this as unproven, not as free organizational rigor.

### Multi-Tenant `e3d-trade`

```text
FutCo e3d-corp ─────────┐
Future Fund e3d-corp ───┼────> e3d-trade
Family Office A ────────┤
SPV-17 ─────────────────┘
```

Different owners issuing different mandates against the same execution engine. Reasonable long-term direction; not needed now, and the service-contract design above should avoid ruling it out later.

### Full Decision Ledger

Beyond `e3d-corp`'s existing Event/Outcome/Experience fields: market regime, input signals, agent opinions, supporting/opposing evidence, risk assumptions, and outcome data at 1/7/30/90-day horizons with max adverse/favorable excursion and benchmark-relative return, attributed by agent/signal/asset/strategy/regime/confidence bucket.

### Market Regimes

Probabilistic classification (e.g. risk expansion, inflationary expansion, tightening/liquidity contraction, crisis/deleveraging, policy intervention/reflation) rather than a single label, used to condition positioning.

### Thesis Graph

A machine-readable causal graph (e.g. Treasury yields ↑ → refinancing pressure ↑ → tightening → systemic stress → policy response → liquidity ↑ → BTC sensitivity ↑) where each edge carries a hypothesis, supporting/contradicting evidence, confidence, and historical accuracy — with the system actively trying to falsify its own causal model. Should build on E3D's existing Thesis objects rather than becoming a second, parallel thesis model.

### Autonomy Levels 4–5

```text
LEVEL 4  Autonomously execute within tightly bounded mandates
LEVEL 5  Broader autonomous portfolio management
```

### Relationship to E3D

```text
E3D (observe: Stories/Theses/Transactions) → e3d-corp (decide/govern) → e3d-trade (act) → Markets → Outcomes → E3D
```

E3D stays a general intelligence platform and should not become an investment adviser merely because FutCo consumes its intelligence internally — keep `e3d-corp`/`e3d-trade` as the layer that touches capital, separate from the public E3D product.

### Phased Rollout (original)

```text
Phase 1  Shadow portfolio
Phase 2  Small proprietary FutCo allocation
Phase 3  Larger proprietary portfolio
Phase 4  Auditable track record
Phase 5  Possible outside capital / managed accounts / fund
```
