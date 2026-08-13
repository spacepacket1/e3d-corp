# Feature Ticket: Build e3d-corp

## Overview

`e3d-corp` helps a company continuously determine what it should do next: observing internal and external signals, discovering evidence-backed opportunities, proposing actions, executing them under explicit authority policies, measuring outcomes, and learning from what happened.

**The primary purpose of this build is to make FutCo materially more successful — not to demonstrate that AI agents can imitate employees.** FutCo's scarce resource right now is not bookkeeping capacity or CRM discipline. It is discovering and pursuing valuable opportunities and generating revenue, starting from its actual current state: a brand-new pivot (blockchain/crypto → AI utilities and consulting), a brand-new front door (`e3d-applied`), and no revenue yet. If this system genuinely helps FutCo find and pursue things worth doing, *that* real usefulness is the demonstration — a public-facing packaging pass comes later, once there's evidence to show, not as a parallel early-track deliverable.

There is no separate "demo instance." This spec builds directly toward FutCo, the real instance, from Phase 1. `e3d-corp` remains company-agnostic in its architecture — the north-star, primitives, and code are not FutCo-specific, and a second company could adopt it by supplying its own instance config, data sources, models, and integrations — but no synthetic seed-data economy is built purely for public demo purposes in this spec. Safety-critical external and financial actions still wait behind explicit human approval from the very first phase; read-only intelligence-gathering about FutCo and its market is low-risk and starts immediately.

The human's actual point of contact with this system is a **private web UI**, built early (Phase 6, right after the Decision framework it depends on) rather than as a late-stage dashboard. Reviewing opportunities and approving/rejecting proposals is real, frequent, ongoing work from the moment the system starts producing anything — CLI-only interaction for that workflow would just be friction standing between a human and a decision they need to make often. The CLI still exists underneath (useful for scripting, automation, and the cron-triggered cycle itself), and both the CLI and the web UI call the exact same library functions for every state transition — there is exactly one implementation of "approve a proposal," reachable through two front doors.

North-star objective:

> Increase FutCo's probability of generating profitable revenue and discovering valuable opportunities while reducing the amount of human operational work required.

The durable primitives this system is built around are **Event → Opportunity → Proposal → Decision → Action → Outcome → Experience**. Agents/models are replaceable reasoning components operating within that runtime — roles with explicit inputs, outputs, capabilities, and authority, not identities permanently tied to one model. The conceptual runtime loop:

```
EVENT → determine applicable work → ROLE/AGENT reasoning → structured PROPOSAL
→ deterministic VALIDATION/POLICY → HUMAN DECISION where required → ACTION
→ OUTCOME → new EVENTS → EVALUATION/LEARNING
```

An **Opportunity** is not necessarily a sales lead. It can be a potential consulting engagement, a product opportunity, a repeated customer request suggesting a feature, a partnership, a distribution opportunity, an interesting technology worth investigating, a GitHub/project trend, a competitor development, a market development, a conference worth attending, an integration opportunity, an operational or cost-saving improvement, or any other evidence-backed action FutCo should consider.

This system progressively proves itself against three milestones, in order of ambition:

1. **Did `e3d-corp` discover something valuable for FutCo that Chris probably would not otherwise have pursued?**
2. **Did `e3d-corp` help FutCo pursue one of those opportunities?**
3. **Did an opportunity discovered and pursued through `e3d-corp` produce a measurable positive outcome?**

Those milestones — not "three agents successfully moving fake CRM records around" — are what this spec is sequenced to prove as early as possible.

Human authority remains fundamental throughout. This is not a fully autonomous company. No external communication, contractual commitment, financial movement, invoice issuance, terminal deal transition, public posting, or comparably consequential action occurs without explicit human approval, enforced at the underlying call sites, not merely as a CLI- or UI-level courtesy check.

---

## Product Goals

- Ship a system that produces real, evidence-backed opportunity recommendations for FutCo as early as the implementation dependencies allow — before any CRM, ledger, or outreach machinery exists.
- Ground every recommendation in real information: FutCo's own knowledge base (`futco-mcp`) and web research, never fabricated capability claims — `e3d-applied`'s own convention against fabricated claims applies here too.
- Preserve "AI suggests, code decides": roles/agents only ever produce structured JSON proposals matching explicit schemas; deterministic code validates, applies policy, owns all state transitions, and controls every side effect. LLM output never directly mutates consequential company state.
- Give the human a single, low-friction place to do the actual ongoing work this system creates for them — reviewing opportunities and deciding what to approve — as a first-class early deliverable, not an afterthought once the backend is "done."
- Make every event, opportunity, proposal, decision, action, and outcome traceable through explicit `causationId`/`correlationId` chains, so a full causal history (`market.signal.detected → opportunity.created → ... → outcome.recorded`) is always reconstructable, and always renders identically whether the triggering decision came from the CLI or the web UI.
- Treat human approval and real business outcome as distinct signals. Capture outcomes explicitly; never assume an approved proposal succeeded or a rejected one would have failed.
- Make authority explicit and policy-driven rather than hard-coded as a binary internal/external split, while keeping the initial policy intentionally conservative — no unattended financial or irreversible authority is introduced merely to demonstrate flexibility.
- Define a clean, loosely-coupled integration/handoff contract with `e3d-pilot` so an approved product/software opportunity can become a real shipped capability, and `e3d-corp` can later discover (via `futco-mcp`) that FutCo can now sell or use it.
- Keep `e3d-corp` adoptable by another company via instance configuration alone — without spending early effort building a parallel public demo economy to prove that adoptability today.
- Defer model fine-tuning (LoRA or otherwise) until an Experience/Evaluation layer exists and offline evaluation provides evidence that training would improve real outcomes — never retrain merely because training is possible, the same reasoning already applied to refusing premature automatic hiring.

---

## Non-Goals

- Do not build a synthetic demo-data economy or a public-facing dashboard. The web UI introduced in Phase 6 is private, authenticated, and shows only FutCo's real data (or, for a future adopting company, theirs) — never a parallel demo track. Public packaging is a later pass, done once there's real evidence to show.
- Do not implement approval/decision/execution logic twice. The web UI and the CLI must call the same underlying library functions for every state transition (creating a Decision, approving a Proposal, running an Action). There is exactly one implementation per transition, auditable identically regardless of which surface triggered it — a `via: "cli"|"web"` field on the Decision record is sufficient distinction, not a second code path.
- Do not build automatic "hiring" (dynamically creating new agent roles based on load thresholds). Roles are declared explicitly in config; a human decides whether and when to add one, informed by real Experience/Evaluation data this system produces.
- Do not build a paper-trading/sandbox economy. Real signals, a real event store, real opportunities, real (conservatively gated) actions from Phase 1 onward.
- Do not extract a shared npm package with `e3d-trade`, `e3d-pilot`, or any other repo. `e3d-sdk` already proved shared packages don't get adopted here. Document shared conventions ("propose JSON, code executes"; provider adapter shape) in writing and hand-implement them fresh, matching `e3d-tokenize`'s copy of `e3d-netdoctor`'s wallet-mint plumbing.
- Do not modify `e3d-trade`, `e3d-pilot`, `spacepacket`, `e3d-applied`, or `futco-mcp` in this spec. Integration is through their existing interfaces (MCP tools, HTTP APIs, or a documented file-based handoff artifact for `e3d-pilot`), verified against their actual current shape before implementation, not assumed.
- Do not build Kafka, distributed event sourcing, message queues, or any infrastructure beyond a deterministic, append-only local Company Event Store. FutCo's current scale needs a semantic contract and traceability, not distributed systems.
- Do not build a heavyweight frontend framework, build pipeline, or SPA toolchain for the web UI. Hand-rolled HTTP server, server-rendered pages or minimal vanilla JS, matching `e3d-trade`'s `server.js` pattern — no new required dependency beyond what a plain Node HTTP server needs.
- Do not build the full Evaluation/Experience metrics surface, the complete 4-level authority taxonomy's higher tiers, multi-model negotiation, or model fine-tuning speculatively ahead of the real usage that would justify them. Define the taxonomy once (cheap, prevents a later breaking schema change) but only exercise the levels each phase actually needs.
- Do not let any role/agent's structured output directly mutate ledger, CRM, or any external-facing state. Every mutation goes through deterministic validation and, where the authority policy requires it, an explicit human Decision — enforced inside the action-execution functions themselves, not only at the CLI or web layer.
- Do not fire any action at authority level 2 or higher (external, financial/contractual, or irreversible/high-value — see Phase 5) without an explicit, logged human Decision. No config flag or environment variable bypasses this for any action type defined in this spec.
- Do not commit real business data anywhere in this repo's git history: no real client names, deal amounts, revenue figures, research findings about real prospects, CRM/ledger exports, or credentials, ever. All of that lives in a private, gitignored instance data directory outside the tracked tree, from Phase 1 onward.
- Do not equate human approval of a proposal with a successful business outcome. They are separate objects (Decision vs. Outcome) captured at separate times, and evaluation metrics must not conflate them.
- Do not build the CRM/ledger/Bookkeeper role until Phase 11, and only then if the pursuit phases (7-9) have produced real deal/transaction volume that justifies it. Do not delete or de-scope them from the eventual system — just do not build them early merely because three equal-weight agents make a clean org-chart demo.
- Do not require a new language runtime beyond Node.js (matching `e3d-trade`) plus what the ecosystem already accepts (`jq`, `curl`, `git`; Python only if/when a future fine-tuning ticket is specified).

---

## Implementation Sequencing

Every phase is chosen to answer one question as early as implementation dependencies allow: **if we build exactly this, does `e3d-corp` start helping FutCo make a better decision sooner?** Phases are ordered vertically toward that goal, not horizontally toward a simulated company org chart.

1. Phase 1 — Repo scaffold, instance config, and runtime foundation
2. Phase 2 — Company Event Store
3. Phase 3 — Research/Evidence layer (`futco-mcp`, web search)
4. Phase 4 — Opportunity model and Opportunity Engine *(first usefulness milestone)*
5. Phase 5 — Proposal, Authority Policy, and Decision framework
6. Phase 6 — Web UI: opportunity and proposal review (the primary human interface from here on)
7. Phase 7 — Pursuit: outreach role and approved external actions *(second usefulness milestone)* — extends the Web UI with an Actions view
8. Phase 8 — `e3d-pilot` handoff contract for product/capability opportunities
9. Phase 9 — Outcome capture and Experience log *(third usefulness milestone)* — extends the Web UI with an Outcomes view and recording form
10. Phase 10 — Evaluation and metrics — extends the Web UI with a metrics view
11. Phase 11 — CRM, ledger, and Bookkeeper role — built only once Phases 7-9 show real deal/transaction volume

A future ticket, written once Phase 10 has produced real evaluation data, will specify: (a) model fine-tuning, gated on evidence that it would improve outcomes; (b) multi-model negotiation for authority-level-3+ decisions, gated on evidence that single-model proposals are wrong often enough to justify the added cost; (c) any hiring/scaling mechanism for additional roles, gated on real cycle-load data. None of the three are detailed in this spec.

---

## Existing Files to Read First

- `futco-mcp`'s tool surface (`list_repos`, `get_repo`, `search_knowledge_base`) and its README/server.js — read before Phase 3 so the research adapter calls it correctly as an MCP client.
- FutCo's `e3d-applied` contact/lead capture implementation — read before wiring it as an event source in Phase 3/4. Confirm the real delivery mechanism; do not assume a webhook shape that doesn't exist.
- `spacepacket`'s payments API surface — read before Phase 11. Do not assume general invoicing data exists there.
- `/Users/cbloom/e3d-pilot`'s CLI (`bin/e3d-pilot --help`), its `config.json` contract, and `docs/build-e3d-pilot.md`'s run-lifecycle/provider-adapter phases — read before Phase 8. The handoff contract must match `e3d-pilot`'s actual current input shape, not an assumed one; verify what `e3d-pilot run` actually expects as a starting objective/idea before designing the handoff artifact.
- `/Users/cbloom/e3d-trade/server.js` — the hand-rolled HTTP server pattern Phase 6's web UI follows.
- `/Users/cbloom/e3d-trade/scout/AGENTS.md` and sibling `AGENTS.md` files — precedent for narrow-contract agent roles, referenced in pattern (not imported) by Phase 4/7's role definitions.

---

## Shared Constraints

### Company-agnostic core, instance-specific data

- All company-identifying configuration lives in `.e3d-corp/instance.json` — the same per-instance config contract `e3d-pilot` uses per-target-repo.
- All real, sensitive instance data lives under a private, gitignored `.e3d-corp/instance/<instance-name>/`. Nothing under this path is ever committed. FutCo's own instance (`name: "futco"`) is populated here from Phase 1 onward and is never pushed.
- The public repo ships `examples/instance.example.json` — a schema-illustrating template with placeholder values, not FutCo's real config.

### Event-driven, not agent-centric

- The Company Event Store (Phase 2) is the backbone every later phase writes to and reads from. Opportunities, Proposals, Decisions, Actions, and Outcomes are all represented as events with `causationId`/`correlationId` linking them into reconstructable chains.
- Roles (Phase 4 onward) are declared with explicit inputs, capabilities, outputs, and authority — see Phase 5 — and are configured with a model/provider assignment, not hard-coded to one.

### Human authority

- Authority levels (defined fully in Phase 5, referenced from Phase 1 onward for vocabulary):
  - `0` — observe (read-only research/ingestion)
  - `1` — internal/reversible write (create/update an Opportunity, draft a Proposal, add an internal note)
  - `2` — external/reversible action (send outreach, hand off to `e3d-pilot`)
  - `3` — financial/contractual action (issue an invoice, record a payment, sign anything)
  - `4` — irreversible/high-value action (mark a deal closed-won/closed-lost, public announcement)
- Levels `0`-`1` are autonomous. Levels `2`-`4` always require an explicit, logged human Decision — no exceptions, no config override, enforced at the action-execution call site.
- The rigor of that Decision scales with the level, uniformly across CLI and web UI: approving a level-2 Proposal immediately triggers its Action (one step — the point of a human-facing surface is removing friction, not adding it for actions that are reversible). Approving a level-3 or level-4 Proposal requires a distinct, explicit second confirmation step before the Action fires (two steps — deliberately more friction for financial/irreversible consequences).
- Deciding what to *pursue* (an Opportunity's status) is always an explicit human Decision regardless of authority level, even though the underlying write is level `1`/low-risk — this is a product choice about where judgment belongs, not a safety-engine requirement.

### Stack

- Node.js (ESM), matching `e3d-trade`'s stack.
- Event store, Opportunity store, Proposal/Decision/Action/Outcome records: append-only JSON-lines files under the instance data directory — deterministic, no external database required for this spec.
- LLM: local OpenAI-compatible endpoint, `LLM_BASE_URL` / `LLM_MODEL` env vars shared with `e3d-maps`/`e3d-trade`'s convention — Qwen2.5 via MLX on `mini@10.0.0.42`, the same machine `e3d-corp` runs on.
- Web UI: hand-rolled Node HTTP server (no framework), basic auth (credentials via env var, never committed) from Phase 6 onward — there is no unauthenticated mode, since there is no demo data to safely serve unauthenticated. Mutating routes are POST-only with standard same-site-cookie CSRF protection; no session/auth framework dependency required for a single-operator tool.
- Deploy: PM2 process(es) on `mini@10.0.0.42`, matching the ecosystem's PM2 convention.
- Research tools: an MCP client against `futco-mcp` (already running) and a pluggable web-search adapter.

### Traceability

- Every event, opportunity, proposal, decision, action, and outcome is appended to `<dataDir>/events.jsonl` (Phase 2) with a stable `id`, `causationId` (the event/record that directly produced this one, or `null`), and `correlationId` (shared across an entire causal chain from originating signal to final outcome). Decision records additionally carry `via: "cli"|"web"` for interface-level traceability only — never as a second implementation.

---

## Phase 1 — Repo Scaffold, Instance Config, and Runtime Foundation

<!-- runner:model=codex:gpt-5.4-mini -->

### Requirements

- This spec file (`docs/build-e3d-corp.md`) already exists in the working tree; the repo is already `git init`'d. Add `LICENSE`, `.gitignore` (must ignore `.e3d-corp/instance/`, `node_modules/`, `.env`), `README.md` stub per the Overview, `package.json` (ESM, Node 18+), `bin/e3d-corp` entrypoint.
- Define `.e3d-corp/instance.json` schema (`config.schema.json` + `e3d-corp config validate <instance-config-path>`). Fields: `name`, `dataDir`, `llm: { baseUrlEnvVar, modelEnvVar }`, `research: { futcoMcpUrl, webSearchProvider }`, `eventSources` (array; Phase 3/4 add the first entries), `roles` (object mapping role name → `{ provider, model }`, Phase 4 populates), `web: { authUserEnvVar, authPassEnvVar, port }` (Phase 6), `authorityNotify: { email, command }` (optional best-effort notification on new level-2+ Decisions pending).
- Create FutCo's real instance directory now: `.e3d-corp/instance/futco/` (gitignored, empty except a `.gitkeep` until Phase 2 populates it), and a real (private, untracked) `.e3d-corp/instance/futco/instance.json` with `name: "futco"`.
- Add `examples/instance.example.json` — a generic template with placeholder company name/values, illustrating the schema for future adopters.
- `bin/e3d-corp --help` documents every subcommand this spec adds, even as `not yet implemented` stubs for later-phase commands.

### Acceptance Criteria

- `node --check bin/e3d-corp` passes.
- `e3d-corp config validate <path-without-instance.json>` fails clearly, naming the missing file.
- `e3d-corp config validate examples/instance.example.json` passes.
- `e3d-corp config validate .e3d-corp/instance/futco/instance.json` passes.
- `.gitignore` correctly ignores `.e3d-corp/instance/`; `git status` after this phase shows no real instance file as trackable.

## Phase 2 — Company Event Store

<!-- runner:model=claude:sonnet -->

### Requirements

- Append-only JSON-lines store at `<dataDir>/events.jsonl`. Each line is a Company Event: `{ id, type, occurredAt, source, subject: { type, id }, payload, causationId, correlationId }`.
- `lib/events/store.js` exposes `appendEvent(event)` (validates required fields, generates `id`/`occurredAt` if absent, rejects an event whose `causationId` doesn't resolve to an existing event when non-null) and `queryEvents({ type, subject, correlationId, since })` for later phases to read from.
- `lib/events/chain.js` exposes `reconstructChain(correlationId)` returning every event sharing that `correlationId`, ordered by `occurredAt`, for later use by Phase 6/9/10.
- `e3d-corp event add --type <type> --source manual --payload <json>` lets a human manually inject a real signal (e.g. "I noticed X" — a `market.signal.detected` or similar event) with a fresh `correlationId` if none is given. This is how real signal capture starts even before any automated source exists.
- `e3d-corp event log [--correlation <id>] [--since <date>]` renders a human-readable, ordered view of events, usable for debugging and reused by Phase 6's UI.

### Acceptance Criteria

- Appending an event with a `causationId` pointing at a nonexistent event fails with a specific, actionable error.
- `event add` with no `--correlation` generates a fresh `correlationId`; a second `event add --correlation <same-id>` links to the same chain.
- `reconstructChain` against a hand-crafted 4-event chain returns all 4 in correct causal order.
- Concurrent `appendEvent` calls do not corrupt `events.jsonl` (append is atomic per line).

## Phase 3 — Research/Evidence Layer

<!-- runner:model=codex:gpt-5.4-mini -->

Read-only. Low risk. This is where real FutCo dogfooding starts.

### Requirements

- `lib/research/adapter.js` defines the interface (`searchKnowledgeBase(query)`, `getRepoInfo(name)`, `webSearch(query)`); `lib/research/futcoMcp.js` implements the first two as an MCP client against the running `futco-mcp` server; `lib/research/webSearch.js` implements the third against a configurable provider (`research.webSearchProvider`).
- Every research call and its result is appended to the Event Store (Phase 2) as an `evidence.gathered` event, with `payload` containing the query and result summary, and `causationId` pointing at whatever event triggered the research (a manual signal, an inbound lead, or a scheduled discovery pass — Phase 4 defines triggers).
- `eventSources` in instance config gains its first real entry: `e3d-applied`'s lead-capture mechanism, read and wired per its actual implementation (see Existing Files to Read First) — each new lead becomes a `lead.received` event with a fresh `correlationId`.
- If `futco-mcp` or the web-search provider is unreachable, the adapter returns a distinct, documented "unavailable" result rather than throwing; callers must degrade gracefully (proceed without that grounding, and record the degradation in the evidence event) rather than fail the whole cycle.

### Acceptance Criteria

- Against the real running `futco-mcp` server, `searchKnowledgeBase("e3d-pilot")` and `getRepoInfo("e3d-pilot")` return real, correctly parsed results, and an `evidence.gathered` event is appended for each call.
- A real (or realistically fixture-fronted, if `e3d-applied`'s live form can't be safely exercised in a test) lead produces a `lead.received` event with a fresh `correlationId`.
- With both research providers unreachable, calls return the documented unavailable result and this is recorded in the resulting `evidence.gathered` event's payload, not silently dropped.

## Phase 4 — Opportunity Model and Opportunity Engine

<!-- runner:model=claude:sonnet -->

**First usefulness milestone.** This phase either produces something Chris wouldn't otherwise have found, or it doesn't — that's the acceptance bar, not just passing unit tests.

### Requirements

- Define the Opportunity schema: `{ id, type, title, description, evidence: [eventId...], score: { value, rationale }, status: "candidate"|"scored"|"reviewed"|"pursuing"|"won"|"lost"|"no-value", sourceEventIds: [...], correlationId, createdAt }`. `type` is an open string, not a fixed enum, covering (non-exhaustively): `consulting-engagement`, `product-opportunity`, `feature-signal`, `partnership`, `distribution`, `technology-to-investigate`, `market-trend`, `competitor-development`, `event-to-attend`, `integration-opportunity`, `operational-improvement`, `cost-saving`, `other`.
- Define the `opportunity.prospect` role in `.e3d-corp/instance.json`'s `roles` config: `{ provider: "local", model: "$LLM_MODEL" }` by default. `lib/roles/opportunityProspect.js` implements it: given one or more recent events (a `lead.received`, a manually-added signal, or a scheduled discovery pass) plus whatever `evidence.gathered` events already exist for that `correlationId`, it calls the configured model with a narrow, task-specific prompt and returns structured JSON matching a documented Opportunity-candidate schema — never free text the pipeline has to guess-parse.
- The role may itself request more research (calling Phase 3's adapters directly, logging `evidence.gathered` events) before producing its final candidate — this is authority level `0`/`1` (read-only research, internal write), fully autonomous.
- Creating an Opportunity record from a role's output is an internal, reversible write (authority level `1`) — autonomous, no approval needed. Emit `opportunity.created` (and `opportunity.scored` once scoring, below, runs) events with `causationId` pointing at the triggering event/evidence and the same `correlationId` as the chain.
- Scoring: a deterministic function (not a second LLM call) combines the role's own confidence/rationale with configurable weights (e.g. evidence count, recency, `type`-specific weighting from instance config) into a single sortable `score.value`. Keep this simple and documented, not a black box.
- `eventSources` also gains a **scheduled discovery** trigger: `e3d-corp run --instance futco` (no built-in scheduler; cron/launchd calls this) checks instance config's `research_topics`-style hints (free-text domains to watch, e.g. "AI utilities for technical businesses", "blockchain-to-AI pivot"), runs a broad discovery pass through the research layer, and feeds any resulting signal into the same `opportunity.prospect` role, exactly as an inbound lead would be.
- Minimal read-only CLI, `e3d-corp opportunities list [--status <status>] [--min-score <n>]` / `opportunities show <id>`, exists in this phase purely as a development/debugging aid while Phase 6's UI doesn't exist yet — it is not the intended long-term human interface.

### Acceptance Criteria

- Against a stubbed LLM endpoint returning fixture JSON, `opportunityProspect` produces a correctly-typed Opportunity candidate, and the resulting `opportunity.created`/`opportunity.scored` events correctly reference their causing evidence/event via `causationId` and share the originating `correlationId`.
- Malformed role output is rejected with a clear error and never produces a half-written Opportunity record.
- **Run this phase for real, against FutCo's actual `futco-mcp` knowledge base and at least one real research topic from instance config, and produce at least one ranked Opportunity that a human (Chris) did not already know about or had not already explicitly told the system to find.** Record the result of this check in the phase's own summary — this is the acceptance criterion that actually matters for this phase; passing it is what makes this spec worth continuing to build on.

## Phase 5 — Proposal, Authority Policy, and Decision Framework

<!-- runner:model=claude:sonnet -->

Generalized from the start — covers both "what to pursue" decisions on Opportunities and "should this action fire" decisions on Proposals, under one Decision model, so Phase 6's UI has one coherent framework to sit on top of rather than two.

### Requirements

- Define the Proposal schema: `{ id, type, payload, proposedBy: { role, provider, model }, authorityLevel, causationId, correlationId, status: "pending"|"approved"|"rejected", createdAt }` and the generalized Decision schema: `{ id, subjectType: "opportunity"|"proposal", subjectId, decision, reason, decidedBy, decidedAt, via: "cli"|"web" }`, both persisted as events (`opportunity.reviewed`, `proposal.approved`/`proposal.rejected`).
- Define the full authority level enum (`0`-`4`, per Shared Constraints) as a documented, versioned policy table (`lib/authority/policy.js`) mapping action `type` → minimum required level, e.g. `{ "send-outreach": 2, "issue-invoice": 3, "mark-deal-closed": 4, "pilot-handoff": 2 }`. This table is read by every action-execution function (Phase 7 onward), not just the CLI or UI — a role/pipeline call to an action function at authority level ≥2 with no approved Decision must fail at that call site, every time, with no override.
- `lib/decisions/decide.js` is the single implementation both the CLI and Phase 6's web UI call: `decideOpportunity(id, decision, reason, decidedBy, via)` and `decideProposal(id, decision, reason, decidedBy, via)`. For level-2 proposals, approval and execution are the same call (immediately triggers the corresponding action-execution function, defined starting Phase 7); for level-3/4, approval only flips status to `approved` and a distinct, separate confirmation step (`confirmAndExecute`) is required before the action fires.
- Thin CLI wrappers exist for scripting/testing and pre-Phase-6 development: `e3d-corp opportunities decide <id> --status ... --reason ...`, `e3d-corp proposals approve|reject <id> --reason ...`. These are not the primary intended interface once Phase 6 ships, but remain fully functional (same underlying calls) indefinitely.
- Optional best-effort notification (`authorityNotify`) fires when a new level-2+ proposal becomes pending; failure to notify never blocks approvability.
- Levels `0`-`1` never generate a Proposal/Decision at all — they're autonomous internal writes, exactly as Phase 4 already implements for Opportunity creation/scoring.

### Acceptance Criteria

- A hand-crafted test proposal at each defined authority level can be approved or rejected via the CLI wrapper, and only an approved level-2+ proposal's corresponding action-execution function will actually run (verified by a test that calls the action function directly, bypassing both CLI and UI, with a `pending` proposal, and asserts it refuses).
- A level-2 test proposal fires its action immediately upon approval (single call); a level-3/4 test proposal requires the separate `confirmAndExecute` step and does not fire on approval alone.
- The full causal chain for an `opportunity.reviewed` or `proposal.created → proposal.approved` pair is reconstructable via `correlationId` back to the originating Opportunity and its originating event, with `via` correctly recorded.

## Phase 6 — Web UI: Opportunity and Proposal Review

<!-- runner:model=claude:sonnet -->

The primary human interface from here forward. Built as soon as there is something real to review and decide on top of — right after Phase 5, not deferred to the end.

### Requirements

- `lib/web/server.js` — hand-rolled Node HTTP server (no framework), matching `e3d-trade`'s `server.js` pattern. Requires basic auth (`web.authUserEnvVar`/`authPassEnvVar`); refuses to start with no credentials configured.
- Routes: `/opportunities` (ranked list, filterable by status/type/score), `/opportunities/:id` (full causal chain via `reconstructChain` — what was observed, why the opportunity was created, supporting evidence, which role/model evaluated it — plus a decide form: `reviewed`/`pursuing`/`no-value`, with a required reason field); `/proposals` (pending queue, summarized by type/authority level/amount-if-financial/recipient-if-external); `/proposals/:id` (detail plus approve/reject form, calling the exact Phase 5 `decideProposal` function — level-2 approvals fire immediately, level-3/4 approvals require the additional confirm step, both enforced server-side regardless of what the form submits).
- Every mutating route is POST-only with same-site-cookie CSRF protection. No route or handler in this phase implements approval/decision logic itself — every mutation is a thin call into `lib/decisions/decide.js` from Phase 5.
- Server-rendered pages (or minimal vanilla JS) are sufficient; no build step, no SPA framework.

### Acceptance Criteria

- Starting the web server with no auth env vars configured refuses to start, naming the missing credential.
- Against real FutCo data from Phase 4, `/opportunities/:id` renders a causal chain identical in content to `e3d-corp opportunities show <id>`'s CLI output.
- Approving a level-2 test proposal through the web form fires its action-execution function exactly once (verified against the same test action function Phase 5 used) and produces a Decision event with `via: "web"`.
- Attempting to approve a level-3/4 test proposal through the single-step approve form does not fire the action without the separate confirm step.
- A CSRF-forged POST to any mutating route (no valid same-site cookie) is rejected.

## Phase 7 — Pursuit: Outreach Role and Approved External Actions

<!-- runner:model=claude:sonnet -->

**Second usefulness milestone.**

### Requirements

- Define the `opportunity.communicator` role (config-assignable model/provider, defaulting to local Qwen). `lib/roles/communicator.js`: given an Opportunity with `status: "pursuing"` (set via Phase 6's decide flow) and its evidence chain, drafts outreach content (email or equivalent) grounded in `futco-mcp` (never claiming a capability FutCo doesn't have) and always creates a Phase 5 Proposal of type `send-outreach` (authority level `2`) — never sends anything itself under any circumstance.
- `lib/actions/sendOutreach.js` is the actual action-execution function: it refuses to run against any proposal not in `approved` status (enforced inside this function, not only the CLI/UI), and on success emits an `outreach.sent` event with `causationId` pointing at the approving Decision and the same `correlationId` as the originating Opportunity/lead chain.
- Extend Phase 6's web UI with an `/actions` view: a log of executed actions (what fired, when, against which proposal/opportunity) — observational, not itself something to "approve" (approval already happened upstream at the Proposal).
- Every drafted-but-unsent outreach and every fired outreach is logged under the instance data directory with enough detail to reconstruct exactly what was sent, to whom, and why.

### Acceptance Criteria

- Against a stubbed LLM endpoint, `communicator` produces a correctly-structured outreach draft and a pending `send-outreach` Proposal — never a directly-sent message.
- Calling `sendOutreach` directly against a `pending` or `rejected` proposal fails with a clear error; against an `approved` one, it succeeds and emits `outreach.sent` with correct `causationId`/`correlationId`.
- The `/actions` view correctly lists a fired outreach with a link back to its originating proposal and opportunity.
- **At least one real, human-approved outreach is sent for a real FutCo opportunity discovered in Phase 4, end to end: opportunity → reviewed as pursuing (via the web UI) → outreach drafted → proposal approved (via the web UI) → outreach actually sent.** This is the phase's real acceptance bar — the mechanical tests above are necessary but not sufficient.

## Phase 8 — `e3d-pilot` Handoff Contract

<!-- runner:model=codex:gpt-5.4-mini -->

For `product-opportunity`/capability-type Opportunities. Loosely coupled by design — `e3d-corp` never calls `e3d-pilot` directly.

### Requirements

- Before implementing, read `e3d-pilot`'s actual current CLI/config contract (per Existing Files to Read First) and confirm what shape of input `e3d-pilot run`/its discover-ideate-draft stages actually expect. Do not assume a shape.
- For an Opportunity of type `product-opportunity` (or similar) marked `pursuing`, define a `pilot-handoff` Proposal (authority level `2` — it commits real engineering time/attention, though it is itself reversible since `e3d-pilot` never merges unattended). On approval, the action-execution function writes a structured handoff artifact — a file under the target repo's own tree or a documented location `e3d-pilot` can consume as a starting objective — containing the Opportunity's evidence, rationale, and score, and emits a `pilot-handoff.created` event with the originating `correlationId` preserved.
- This phase does not invoke `e3d-pilot` itself. A human runs `e3d-pilot` separately, pointed at the handoff artifact, exactly as they would run it manually today.
- Add `e3d-corp opportunities check-shipped <id>` (available from both CLI and as a button on `/opportunities/:id` in the web UI) that re-queries `futco-mcp` (`list_repos`/`get_repo`) for evidence a related capability now exists (e.g. a new repo, or a repo whose summary now mentions the relevant capability), and if found, appends a `capability.shipped` event with `causationId` back to the `pilot-handoff.created` event, closing the loop for Phase 9's outcome tracking. This is a human-triggered check, not automated polling, in this spec.

### Acceptance Criteria

- The handoff artifact's shape is verified against `e3d-pilot`'s actual current input contract, not merely internally consistent — cite the specific file/section of `e3d-pilot`'s docs or code that confirms the shape is usable.
- A hand-crafted `product-opportunity` marked `pursuing`, once its `pilot-handoff` proposal is approved via the web UI, produces a well-formed handoff artifact and a `pilot-handoff.created` event with correct `correlationId`.
- `check-shipped` against a fixture `futco-mcp` response containing a plausibly-related new repo correctly appends `capability.shipped`; against one with no match, it reports no match found without appending a false event.

## Phase 9 — Outcome Capture and Experience Log

<!-- runner:model=claude:sonnet -->

**Third usefulness milestone.** This is where the spec stops treating human approval as a proxy for success.

### Requirements

- Define the Outcome schema: `{ id, subjectCorrelationId, type, payload, occurredAt }`, covering (non-exhaustively): `prospect.replied`, `meeting.booked`, `proposal.accepted`, `proposal.rejected`, `deal.won`, `deal.lost`, `invoice.paid`, `capability.shipped` (already emitted by Phase 8), `customer.adopted`, `opportunity.no-value`. Persisted as events.
- Most outcomes aren't automatically observable without deeper email/CRM integration this spec doesn't build yet. `e3d-corp outcomes record --correlation <id> --type <type> --payload <json>` is the CLI primitive; extend Phase 6's web UI with an `/outcomes` view (list of recorded outcomes) and a recording form on `/opportunities/:id` (tied to that opportunity's `correlationId`) — a human records what actually happened, either surface calling the same underlying `lib/outcomes/record.js` function.
- `lib/experience/assemble.js` builds an Experience record per meaningfully-completed chain: `{ correlationId, context, originatingEvent, evidence: [...], role, model, proposal, decision, action, outcome, latencyMs, costEstimate }` — assembled by walking `reconstructChain(correlationId)` and pulling the relevant fields out of each event type. Written to `<dataDir>/experience.jsonl`.
- `e3d-corp experience show <correlationId>` (and the equivalent view on `/opportunities/:id` in the web UI) renders one fully assembled Experience record.

### Acceptance Criteria

- `outcomes record` (via CLI or the web form) against a real chain from Phase 7 (a sent outreach) correctly appends an outcome event and is reflected in that chain's `reconstructChain` output regardless of which surface recorded it.
- `assemble.js` against a fixture chain covering event → opportunity → proposal → decision → action → outcome produces a complete, correctly-populated Experience record with no missing required field.
- **At least one real Experience record exists for a real FutCo opportunity that reached a real outcome** (even a `no-value` or `rejected` outcome counts — the point is a complete, real, traceable chain from signal to result, not a fixture).

## Phase 10 — Evaluation and Metrics

<!-- runner:model=codex:gpt-5.4-mini -->

Read-only reporting over the Experience log. No training happens in this phase or this spec.

### Requirements

- `lib/evaluation/metrics.js` computes, from `experience.jsonl`: opportunities discovered (count, by type), opportunity acceptance rate (`opportunities.reviewed` with `pursuing` vs. `no-value`), human override/rejection rate, outreach response rate, meeting/close rate where applicable, revenue attributable to a chain (sum of any `invoice.paid` outcomes correlated back to an Opportunity), cost per useful opportunity (LLM cost/latency summed per chain, per Phase 9's `costEstimate`, divided by chains reaching a positive outcome), and latency/cost broken down by role and model.
- `e3d-corp evaluate report [--since <date>]` (and an equivalent `/metrics` view in the web UI, read-only, extending Phase 6) renders a human-readable summary of the above.
- Explicitly do not compute or expose any "training readiness" signal or trigger in this phase — that judgment belongs to the future fine-tuning ticket referenced in Implementation Sequencing, once there's enough real Experience data for it to mean something.

### Acceptance Criteria

- Against a fixture `experience.jsonl` with a known mix of outcomes, `evaluate report` produces metrics matching hand-computed expected values for every metric listed above, and `/metrics` renders the same values.
- Running `evaluate report` against real (even sparse) FutCo experience data produced by Phases 4-9 produces a real, non-fabricated report — even if most numbers are small or zero at this stage, the report must accurately reflect that rather than presenting placeholder/demo numbers.

## Phase 11 — CRM, Ledger, and Bookkeeper Role

<!-- runner:model=claude:sonnet -->

**Do not begin this phase until Phases 7-9 have produced real pursued opportunities generating real deals or transactions to track.** This phase exists in this spec for completeness and to avoid an awkward future re-architecture, not because it's next in line by default.

### Requirements

- `lib/crm/adapter.js` defines a CRM interface (`getContact`, `upsertContact`, `listDeals`, `createDeal`, `updateDealStage`, `addNote`); a concrete adapter (Twenty CRM, self-hosted via Docker Compose, or another OSS CRM chosen at implementation time) implements it with zero CRM-specific types leaking into pipeline code. Marking a deal `closed-won`/`closed-lost` is authority level `4` and must go through Phase 5's Decision framework, via the web UI's decision surface extended to cover deals.
- Append-only double-entry ledger at `<dataDir>/ledger.jsonl`: `{ id, date, description, entries: [{ account, debit|credit, amount }], status, proposedBy, createdAt }`, validated for balanced debits/credits before any append, same discipline as Phase 2's event store.
- Define the `finance.bookkeeper` role: categorizes transactions into structured ledger-entry proposals (authority level `1` to propose, `3` to apply — issuing/applying a real ledger entry requires Decision, with the two-step confirm from Phase 5's level-3 rule).
- Wire `spacepacket`'s real product-revenue API (Cast/netdoctor/tokenize) as a read-only ledger-entry source, idempotent per ingested event (per Existing Files to Read First — confirm the real available endpoints before assuming general invoicing data exists there).

### Acceptance Criteria

- Proposing an unbalanced ledger transaction fails with a specific error naming the imbalance.
- Attempting to move a deal to `closed-won`/`closed-lost` directly, bypassing Phase 5's Decision flow, is rejected at the adapter/action call site itself.
- Re-ingesting the same `spacepacket` revenue event never creates a duplicate ledger proposal.
- At least one real transaction traceable back to a Phase 4-9 Opportunity (i.e. revenue that this system's own opportunity-discovery/pursuit work plausibly contributed to) is correctly categorized and posted.
