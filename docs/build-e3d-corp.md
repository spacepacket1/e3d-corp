# Feature Ticket: Build e3d-corp

## Overview

`e3d-corp` helps a company continuously determine what it should do next: observing internal and external signals, discovering evidence-backed opportunities, proposing actions, executing them under explicit authority policies, measuring outcomes, and learning from what happened.

**The primary purpose of this build is to make FutCo materially more successful — not to demonstrate that AI agents can imitate employees.** FutCo's scarce resource right now is not bookkeeping capacity or CRM discipline. It is discovering and pursuing valuable opportunities and generating revenue, starting from its actual current state: a brand-new pivot (blockchain/crypto → AI utilities and consulting), a brand-new front door (`e3d-applied`), and no revenue yet. If this system genuinely helps FutCo find and pursue things worth doing, *that* real usefulness is the demonstration — a public-facing packaging pass comes later, once there's evidence to show, not as a parallel early-track deliverable.

There is no separate "demo instance." This spec builds directly toward FutCo, the real instance, from Phase 1. `e3d-corp` remains company-agnostic in its architecture — the north-star, primitives, and code are not FutCo-specific, and a second company could adopt it by supplying its own instance config, data sources, models, and integrations — but no synthetic seed-data economy is built purely for public demo purposes in this spec. Safety-critical external and financial actions still wait behind explicit human approval from the very first phase; read-only intelligence-gathering about FutCo and its market is low-risk and starts immediately.

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

Human authority remains fundamental throughout. This is not a fully autonomous company. No external communication, contractual commitment, financial movement, invoice issuance, terminal deal transition, public posting, or comparably consequential action occurs without explicit human approval, enforced at the underlying call sites, not merely as a CLI-level courtesy check.

---

## Product Goals

- Ship a system that produces real, evidence-backed opportunity recommendations for FutCo as early as the implementation dependencies allow — before any CRM, ledger, or outreach machinery exists.
- Ground every recommendation in real information: FutCo's own knowledge base (`futco-mcp`) and web research, never fabricated capability claims — `e3d-applied`'s own convention against fabricated claims applies here too.
- Preserve "AI suggests, code decides": roles/agents only ever produce structured JSON proposals matching explicit schemas; deterministic code validates, applies policy, owns all state transitions, and controls every side effect. LLM output never directly mutates consequential company state.
- Make every event, opportunity, proposal, decision, action, and outcome traceable through explicit `causationId`/`correlationId` chains, so a full causal history (`market.signal.detected → opportunity.created → ... → outcome.recorded`) is always reconstructable.
- Treat human approval and real business outcome as distinct signals. Capture outcomes explicitly; never assume an approved proposal succeeded or a rejected one would have failed.
- Make authority explicit and policy-driven rather than hard-coded as a binary internal/external split, while keeping the initial policy intentionally conservative — no unattended financial or irreversible authority is introduced merely to demonstrate flexibility.
- Define a clean, loosely-coupled integration/handoff contract with `e3d-pilot` so an approved product/software opportunity can become a real shipped capability, and `e3d-corp` can later discover (via `futco-mcp`) that FutCo can now sell or use it.
- Keep `e3d-corp` adoptable by another company via instance configuration alone — without spending Tranche-1 effort building a parallel public demo economy to prove that adoptability today.
- Defer model fine-tuning (LoRA or otherwise) until an Experience/Evaluation layer exists and offline evaluation provides evidence that training would improve real outcomes — never retrain merely because training is possible, the same reasoning already applied to refusing premature automatic hiring.

---

## Non-Goals

- Do not build a synthetic demo-data economy, a self-hosted demo CRM, or a public dashboard as an early or parallel deliverable. Public-facing packaging is a later pass, done once there's real evidence to show.
- Do not build automatic "hiring" (dynamically creating new agent roles based on load thresholds). Roles are declared explicitly in config; a human decides whether and when to add one, informed by real Experience/Evaluation data this system produces.
- Do not build a paper-trading/sandbox economy. Real signals, a real event store, real opportunities, real (conservatively gated) actions from Phase 1 onward.
- Do not extract a shared npm package with `e3d-trade`, `e3d-pilot`, or any other repo. `e3d-sdk` already proved shared packages don't get adopted here. Document shared conventions ("propose JSON, code executes"; provider adapter shape) in writing and hand-implement them fresh, matching `e3d-tokenize`'s copy of `e3d-netdoctor`'s wallet-mint plumbing.
- Do not modify `e3d-trade`, `e3d-pilot`, `spacepacket`, `e3d-applied`, or `futco-mcp` in this spec. Integration is through their existing interfaces (MCP tools, HTTP APIs, or a documented file-based handoff artifact for `e3d-pilot`), verified against their actual current shape before implementation, not assumed.
- Do not build Kafka, distributed event sourcing, message queues, or any infrastructure beyond a deterministic, append-only local Company Event Store. FutCo's current scale needs a semantic contract and traceability, not distributed systems.
- Do not build the full Evaluation/Experience metrics surface, the complete 4-level authority taxonomy's higher tiers, multi-model negotiation, or model fine-tuning speculatively ahead of the real usage that would justify them. Define the taxonomy once (cheap, prevents a later breaking schema change) but only exercise the levels each phase actually needs.
- Do not let any role/agent's structured output directly mutate ledger, CRM, or any external-facing state. Every mutation goes through deterministic validation and, where the authority policy requires it, an explicit human Decision — enforced inside the action-execution functions themselves, not only at the CLI layer.
- Do not fire any action at authority level 2 or higher (external, financial/contractual, or irreversible/high-value — see Phase 6) without an explicit, logged human Decision. No config flag or environment variable bypasses this for any action type defined in this spec.
- Do not commit real business data anywhere in this repo's git history: no real client names, deal amounts, revenue figures, research findings about real prospects, CRM/ledger exports, or credentials, ever. All of that lives in a private, gitignored instance data directory outside the tracked tree, from Phase 1 onward.
- Do not equate human approval of a proposal with a successful business outcome. They are separate objects (Decision vs. Outcome) captured at separate times, and evaluation metrics must not conflate them.
- Do not build the CRM/ledger/Bookkeeper role until Phase 12, and only then if the pursuit phases (7-9) have produced real deal/transaction volume that justifies it. Do not delete or de-scope them from the eventual system — just do not build them early merely because three equal-weight agents make a clean org-chart demo.
- Do not require a new language runtime beyond Node.js (matching `e3d-trade`) plus what the ecosystem already accepts (`jq`, `curl`, `git`; Python only if/when Phase 13's fine-tuning work is eventually specified).

---

## Implementation Sequencing

Every phase is chosen to answer one question as early as implementation dependencies allow: **if we build exactly this, does `e3d-corp` start helping FutCo make a better decision sooner?** Phases are ordered vertically toward that goal, not horizontally toward a simulated company org chart.

1. Phase 1 — Repo scaffold, instance config, and runtime foundation
2. Phase 2 — Company Event Store
3. Phase 3 — Research/Evidence layer (`futco-mcp`, web search)
4. Phase 4 — Opportunity model and Opportunity Engine *(first usefulness milestone)*
5. Phase 5 — Opportunity review CLI and human feedback loop
6. Phase 6 — Proposal, Authority Policy, and Decision framework
7. Phase 7 — Pursuit: outreach role and approved external actions *(second usefulness milestone)*
8. Phase 8 — `e3d-pilot` handoff contract for product/capability opportunities
9. Phase 9 — Outcome capture and Experience log *(third usefulness milestone)*
10. Phase 10 — Evaluation and metrics
11. Phase 11 — Dashboard (private, FutCo real data)
12. Phase 12 — CRM, ledger, and Bookkeeper role — built only once Phases 7-9 show real deal/transaction volume

A future ticket, written once Phase 10 has produced real evaluation data, will specify: (a) model fine-tuning, gated on evidence that it would improve outcomes; (b) multi-model negotiation for authority-level-3+ decisions, gated on evidence that single-model proposals are wrong often enough to justify the added cost; (c) any hiring/scaling mechanism for additional roles, gated on real cycle-load data. None of the three are detailed in this spec.

---

## Existing Files to Read First

- `futco-mcp`'s tool surface (`list_repos`, `get_repo`, `search_knowledge_base`) and its README/server.js — read before Phase 3 so the research adapter calls it correctly as an MCP client.
- FutCo's `e3d-applied` contact/lead capture implementation — read before wiring it as an event source in Phase 3/4. Confirm the real delivery mechanism; do not assume a webhook shape that doesn't exist.
- `spacepacket`'s payments API surface — read before Phase 12. Do not assume general invoicing data exists there.
- `/Users/cbloom/e3d-pilot`'s CLI (`bin/e3d-pilot --help`), its `config.json` contract, and `docs/build-e3d-pilot.md`'s run-lifecycle/provider-adapter phases — read before Phase 8. The handoff contract must match `e3d-pilot`'s actual current input shape, not an assumed one; verify what `e3d-pilot run` actually expects as a starting objective/idea before designing the handoff artifact.
- `/Users/cbloom/e3d-trade/scout/AGENTS.md` and sibling `AGENTS.md` files — precedent for narrow-contract agent roles, referenced in pattern (not imported) by Phase 4/7's role definitions.

---

## Shared Constraints

### Company-agnostic core, instance-specific data

- All company-identifying configuration lives in `.e3d-corp/instance.json` — the same per-instance config contract `e3d-pilot` uses per-target-repo.
- All real, sensitive instance data lives under a private, gitignored `.e3d-corp/instance/<instance-name>/`. Nothing under this path is ever committed. FutCo's own instance (`name: "futco"`) is populated here from Phase 1 onward and is never pushed.
- The public repo ships `examples/instance.example.json` — a schema-illustrating template with placeholder values, not FutCo's real config and not a maintained demo economy.

### Event-driven, not agent-centric

- The Company Event Store (Phase 2) is the backbone every later phase writes to and reads from. Opportunities, Proposals, Decisions, Actions, and Outcomes are all represented as events with `causationId`/`correlationId` linking them into reconstructable chains.
- Roles (Phase 4 onward) are declared with explicit inputs, capabilities, outputs, and authority — see Phase 6 — and are configured with a model/provider assignment, not hard-coded to one.

### Human authority

- Authority levels (defined fully in Phase 6, referenced from Phase 1 onward for vocabulary):
  - `0` — observe (read-only research/ingestion)
  - `1` — internal/reversible write (create/update an Opportunity, draft a Proposal, add an internal note)
  - `2` — external/reversible action (send outreach, hand off to `e3d-pilot`)
  - `3` — financial/contractual action (issue an invoice, record a payment, sign anything)
  - `4` — irreversible/high-value action (mark a deal closed-won/closed-lost, public announcement)
- Levels `0`-`1` are autonomous. Levels `2`-`4` always require an explicit, logged human Decision — no exceptions, no config override, enforced at the action-execution call site.

### Stack

- Node.js (ESM), matching `e3d-trade`'s stack.
- Event store, Opportunity store, Proposal/Decision/Action/Outcome records: append-only JSON-lines files under the instance data directory — deterministic, no external database required for this spec.
- LLM: local OpenAI-compatible endpoint, `LLM_BASE_URL` / `LLM_MODEL` env vars shared with `e3d-maps`/`e3d-trade`'s convention — Qwen2.5 via MLX on `mini@10.0.0.42`, the same machine `e3d-corp` runs on for the FutCo instance.
- Deploy: PM2 process(es) on `mini@10.0.0.42`, matching the ecosystem's PM2 convention.
- Research tools: an MCP client against `futco-mcp` (already running) and a pluggable web-search adapter.

### Traceability

- Every event, opportunity, proposal, decision, action, and outcome is appended to `<dataDir>/events.jsonl` (Phase 2) with a stable `id`, `causationId` (the event/record that directly produced this one, or `null`), and `correlationId` (shared across an entire causal chain from originating signal to final outcome).

---

## Phase 1 — Repo Scaffold, Instance Config, and Runtime Foundation

<!-- runner:model=codex:gpt-5.4-mini -->

### Requirements

- This spec file (`docs/build-e3d-corp.md`) already exists in the working tree; the repo is already `git init`'d. Add `LICENSE`, `.gitignore` (must ignore `.e3d-corp/instance/`, `node_modules/`, `.env`), `README.md` stub per the Overview, `package.json` (ESM, Node 18+), `bin/e3d-corp` entrypoint.
- Define `.e3d-corp/instance.json` schema (`config.schema.json` + `e3d-corp config validate <instance-config-path>`). Fields: `name`, `dataDir`, `llm: { baseUrlEnvVar, modelEnvVar }`, `research: { futcoMcpUrl, webSearchProvider }`, `eventSources` (array; Phase 3/4 add the first entries), `roles` (object mapping role name → `{ provider, model }`, Phase 4 populates), `authorityNotify: { email, command }` (optional best-effort notification on new level-2+ Decisions pending).
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
- `lib/events/chain.js` exposes `reconstructChain(correlationId)` returning every event sharing that `correlationId`, ordered by `occurredAt`, for later use by Phase 9/11.
- `e3d-corp event add --type <type> --source manual --payload <json>` lets a human manually inject a real signal (e.g. "I noticed X" — a `market.signal.detected` or similar event) with a fresh `correlationId` if none is given. This is how real signal capture starts even before any automated source exists.
- `e3d-corp event log [--correlation <id>] [--since <date>]` renders a human-readable, ordered view of events, usable for debugging and for Phase 11's eventual dashboard.

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
- `e3d-corp opportunities list [--status <status>] [--min-score <n>]` renders ranked, human-readable output.

### Acceptance Criteria

- Against a stubbed LLM endpoint returning fixture JSON, `opportunityProspect` produces a correctly-typed Opportunity candidate, and the resulting `opportunity.created`/`opportunity.scored` events correctly reference their causing evidence/event via `causationId` and share the originating `correlationId`.
- Malformed role output is rejected with a clear error and never produces a half-written Opportunity record.
- **Run this phase for real, against FutCo's actual `futco-mcp` knowledge base and at least one real research topic from instance config, and produce at least one ranked Opportunity that a human (Chris) did not already know about or had not already explicitly told the system to find.** Record the result of this check in the phase's own summary — this is the acceptance criterion that actually matters for this phase; passing it is what makes this spec worth continuing to build on.

## Phase 5 — Opportunity Review CLI and Human Feedback Loop

<!-- runner:model=codex:gpt-5.4-mini -->

### Requirements

- `e3d-corp opportunities show <id>` renders one opportunity's full causal chain (via Phase 2's `reconstructChain`): what was observed, why it was created, supporting evidence, which role/model evaluated it, current score/status.
- `e3d-corp opportunities decide <id> --status reviewed|pursuing|no-value --reason <text>` is how a human records a first-pass judgment on an opportunity. This is a Decision record (formalized fully in Phase 6; this phase introduces the minimal version scoped to opportunity status changes only) — append `opportunity.reviewed` event with the decision and reason, update the Opportunity's `status`.
- This is where the human-override signal starts accumulating: every `opportunities decide` call is itself an event, queryable later by Phase 10's evaluation layer as "opportunity acceptance rate" / "human override rate."
- No opportunity review action in this phase has any external or financial effect — it only changes internal state and emits events. Marking something `pursuing` does not itself do anything yet; Phase 7 is what acts on that status.

### Acceptance Criteria

- `opportunities show <id>` against a Phase 4-produced opportunity renders a coherent, complete causal chain from originating event to current status.
- `opportunities decide` correctly updates status and appends a queryable `opportunity.reviewed` event with `reason` preserved.
- Querying events by `type: "opportunity.reviewed"` across several decisions yields a computable acceptance/override rate (exercised by a test with a mix of accepted/rejected decisions).

## Phase 6 — Proposal, Authority Policy, and Decision Framework

<!-- runner:model=claude:sonnet -->

Generalizes Phase 5's opportunity-status decision into the full framework every later external/financial action type (Phase 7 onward) uses. Build and test this against synthetic proposals before Phase 7's real outreach role exists.

### Requirements

- Define the Proposal schema: `{ id, type, payload, proposedBy: { role, provider, model }, authorityLevel, causationId, correlationId, status: "pending"|"approved"|"rejected", createdAt }` and the Decision schema: `{ id, proposalId, decidedBy, decision: "approved"|"rejected", reason, decidedAt }`, both persisted as events (`proposal.created`, `proposal.approved`/`proposal.rejected`) in addition to any dedicated file needed for the pending-queue view.
- Define the full authority level enum (`0`-`4`, per Shared Constraints) as a documented, versioned policy table (`lib/authority/policy.js`) mapping action `type` → minimum required level, e.g. `{ "send-outreach": 2, "issue-invoice": 3, "mark-deal-closed": 4, "pilot-handoff": 2 }`. This table is read by every action-execution function (Phase 7 onward), not just the CLI — a role/pipeline call to an action function at authority level ≥2 with no approved Decision must fail at that call site, every time, with no override.
- `e3d-corp proposals list [--instance <name>]` lists pending proposals with enough summary detail (type, authority level, amount if financial, recipient if external) to decide without opening raw JSON.
- `e3d-corp proposals approve <id>` / `e3d-corp proposals reject <id> --reason <text>` are the only ways a proposal's status changes from `pending`. Approving does not itself fire the action — it only unblocks the specific downstream action-execution call (Phase 7+) to actually run, so an approval can never cascade into an unintended side effect.
- Optional best-effort notification (`authorityNotify`) fires when a new level-2+ proposal becomes pending; failure to notify never blocks CLI approvability.
- Levels `0`-`1` never generate a Proposal/Decision at all — they're autonomous internal writes, exactly as Phase 4/5 already implement them. This phase does not change that; it only formalizes the levels `2`+ path.

### Acceptance Criteria

- A hand-crafted test proposal at each defined authority level can be approved or rejected via CLI, and only an approved level-2+ proposal's corresponding action-execution function will actually run (verified by a test that calls the action function directly, bypassing the CLI, with a `pending` proposal, and asserts it refuses).
- `proposals list` against 3 pending proposals of different types/levels renders all 3 with correct summaries.
- The full causal chain for a `proposal.created → proposal.approved` pair is reconstructable via `correlationId` back to the originating Opportunity and its originating event.

## Phase 7 — Pursuit: Outreach Role and Approved External Actions

<!-- runner:model=claude:sonnet -->

**Second usefulness milestone.**

### Requirements

- Define the `opportunity.communicator` role (config-assignable model/provider, defaulting to local Qwen). `lib/roles/communicator.js`: given an Opportunity with `status: "pursuing"` (set via Phase 5's decision flow) and its evidence chain, drafts outreach content (email or equivalent) grounded in `futco-mcp` (never claiming a capability FutCo doesn't have) and always creates a Phase 6 Proposal of type `send-outreach` (authority level `2`) — never sends anything itself under any circumstance.
- `lib/actions/sendOutreach.js` is the actual action-execution function: it refuses to run against any proposal not in `approved` status (enforced inside this function, not only the CLI), and on success emits an `outreach.sent` event with `causationId` pointing at the approving Decision and the same `correlationId` as the originating Opportunity/lead chain.
- `e3d-corp actions run <proposal-id>` is the CLI surface that invokes the correct action-execution function for an approved proposal's `type`.
- Every drafted-but-unsent outreach and every fired outreach is logged under the instance data directory with enough detail to reconstruct exactly what was sent, to whom, and why.

### Acceptance Criteria

- Against a stubbed LLM endpoint, `communicator` produces a correctly-structured outreach draft and a pending `send-outreach` Proposal — never a directly-sent message.
- Calling `sendOutreach` directly against a `pending` or `rejected` proposal fails with a clear error; against an `approved` one, it succeeds and emits `outreach.sent` with correct `causationId`/`correlationId`.
- **At least one real, human-approved outreach is sent for a real FutCo opportunity discovered in Phase 4, end to end: opportunity → reviewed as pursuing → outreach drafted → proposal approved by a human → outreach actually sent.** This is the phase's real acceptance bar — the mechanical tests above are necessary but not sufficient.

## Phase 8 — `e3d-pilot` Handoff Contract

<!-- runner:model=codex:gpt-5.4-mini -->

For `product-opportunity`/capability-type Opportunities. Loosely coupled by design — `e3d-corp` never calls `e3d-pilot` directly.

### Requirements

- Before implementing, read `e3d-pilot`'s actual current CLI/config contract (per Existing Files to Read First) and confirm what shape of input `e3d-pilot run`/its discover-ideate-draft stages actually expect. Do not assume a shape.
- For an Opportunity of type `product-opportunity` (or similar) marked `pursuing`, define a `pilot-handoff` Proposal (authority level `2` — it commits real engineering time/attention, though it is itself reversible since `e3d-pilot` never merges unattended). On approval, the action-execution function writes a structured handoff artifact — a file under the target repo's own tree or a documented location `e3d-pilot` can consume as a starting objective — containing the Opportunity's evidence, rationale, and score, and emits a `pilot-handoff.created` event with the originating `correlationId` preserved.
- This phase does not invoke `e3d-pilot` itself. A human runs `e3d-pilot` separately, pointed at the handoff artifact, exactly as they would run it manually today.
- Add a lightweight, human-triggered `e3d-corp opportunities check-shipped <id>` that re-queries `futco-mcp` (`list_repos`/`get_repo`) for evidence a related capability now exists (e.g. a new repo, or a repo whose summary now mentions the relevant capability), and if found, appends a `capability.shipped` event with `causationId` back to the `pilot-handoff.created` event, closing the loop for Phase 9's outcome tracking. This is a manual check, not automated polling, in this spec.

### Acceptance Criteria

- The handoff artifact's shape is verified against `e3d-pilot`'s actual current input contract, not merely internally consistent — cite the specific file/section of `e3d-pilot`'s docs or code that confirms the shape is usable.
- A hand-crafted `product-opportunity` marked `pursuing`, once its `pilot-handoff` proposal is approved, produces a well-formed handoff artifact and a `pilot-handoff.created` event with correct `correlationId`.
- `check-shipped` against a fixture `futco-mcp` response containing a plausibly-related new repo correctly appends `capability.shipped`; against one with no match, it reports no match found without appending a false event.

## Phase 9 — Outcome Capture and Experience Log

<!-- runner:model=claude:sonnet -->

**Third usefulness milestone.** This is where the spec stops treating human approval as a proxy for success.

### Requirements

- Define the Outcome schema: `{ id, subjectCorrelationId, type, payload, occurredAt }`, covering (non-exhaustively): `prospect.replied`, `meeting.booked`, `proposal.accepted`, `proposal.rejected`, `deal.won`, `deal.lost`, `invoice.paid`, `capability.shipped` (already emitted by Phase 8), `customer.adopted`, `opportunity.no-value`. Persisted as events.
- Most outcomes aren't automatically observable without deeper email/CRM integration this spec doesn't build yet. `e3d-corp outcomes record --correlation <id> --type <type> --payload <json>` is the primary Tranche-1 mechanism: a human records what actually happened, tied back to the full causal chain via `correlationId`.
- `lib/experience/assemble.js` builds an Experience record per meaningfully-completed chain: `{ correlationId, context, originatingEvent, evidence: [...], role, model, proposal, decision, action, outcome, latencyMs, costEstimate }` — assembled by walking `reconstructChain(correlationId)` and pulling the relevant fields out of each event type. Written to `<dataDir>/experience.jsonl`.
- `e3d-corp experience show <correlationId>` renders one fully assembled Experience record.

### Acceptance Criteria

- `outcomes record` against a real chain from Phase 7 (a sent outreach) correctly appends an outcome event and is reflected in that chain's `reconstructChain` output.
- `assemble.js` against a fixture chain covering event → opportunity → proposal → decision → action → outcome produces a complete, correctly-populated Experience record with no missing required field.
- **At least one real Experience record exists for a real FutCo opportunity that reached a real outcome** (even a `no-value` or `rejected` outcome counts — the point is a complete, real, traceable chain from signal to result, not a fixture).

## Phase 10 — Evaluation and Metrics

<!-- runner:model=codex:gpt-5.4-mini -->

Read-only reporting over the Experience log. No training happens in this phase or this spec.

### Requirements

- `lib/evaluation/metrics.js` computes, from `experience.jsonl`: opportunities discovered (count, by type), opportunity acceptance rate (`opportunities.reviewed` with `pursuing` vs. `no-value`), human override/rejection rate, outreach response rate, meeting/close rate where applicable, revenue attributable to a chain (sum of any `invoice.paid` outcomes correlated back to an Opportunity), cost per useful opportunity (LLM cost/latency summed per chain, per Phase 9's `costEstimate`, divided by chains reaching a positive outcome), and latency/cost broken down by role and model.
- `e3d-corp evaluate report [--since <date>]` renders a human-readable summary of the above.
- Explicitly do not compute or expose any "training readiness" signal or trigger in this phase — that judgment belongs to the future fine-tuning ticket referenced in Implementation Sequencing, once there's enough real Experience data for it to mean something.

### Acceptance Criteria

- Against a fixture `experience.jsonl` with a known mix of outcomes, `evaluate report` produces metrics matching hand-computed expected values for every metric listed above.
- Running `evaluate report` against real (even sparse) FutCo experience data produced by Phases 4-9 produces a real, non-fabricated report — even if most numbers are small or zero at this stage, the report must accurately reflect that rather than presenting placeholder/demo numbers.

## Phase 11 — Dashboard

<!-- runner:model=claude:sonnet -->

Private, authenticated, FutCo's real data — there is no demo mode in this spec.

### Requirements

- Minimal web dashboard (hand-rolled HTTP server, matching `e3d-trade`'s `server.js` pattern) built around Opportunities and causal chains, not "watch the agents work": opportunities discovered (ranked, with score/evidence), pending Decisions, recent Company Events, actions taken, outcomes, attributable value where measurable, role/model activity, Phase 10's evaluation metrics.
- Clicking an opportunity reconstructs its full causal chain end to end: what was observed → why an opportunity was created → supporting evidence → which role/model evaluated it → proposal → human decision → action → eventual outcome.
- Requires basic auth (credentials via env var, never committed); refuses to start with no credentials configured — there is no unauthenticated mode, since there is no demo data to safely serve unauthenticated.
- Read-only: no approve/reject/decide action is exposed through the web UI in this spec — those stay deliberate CLI actions (Phases 5-7) so there's exactly one code path that can move a Proposal or Opportunity out of `pending`.

### Acceptance Criteria

- Running the dashboard with no auth env vars configured refuses to start, naming the missing credential.
- Against real FutCo data from Phases 4-10, an opportunity's detail view correctly renders its full causal chain, matching what `e3d-corp opportunities show`/`experience show` render at the CLI.
- No route or button in the dashboard can change any record's status.

## Phase 12 — CRM, Ledger, and Bookkeeper Role

<!-- runner:model=claude:sonnet -->

**Do not begin this phase until Phases 7-9 have produced real pursued opportunities generating real deals or transactions to track.** This phase exists in this spec for completeness and to avoid an awkward future re-architecture, not because it's next in line by default.

### Requirements

- `lib/crm/adapter.js` defines a CRM interface (`getContact`, `upsertContact`, `listDeals`, `createDeal`, `updateDealStage`, `addNote`); a concrete adapter (Twenty CRM, self-hosted via Docker Compose, or another OSS CRM chosen at implementation time) implements it with zero CRM-specific types leaking into pipeline code. Marking a deal `closed-won`/`closed-lost` is authority level `4` and must go through Phase 6's Decision framework.
- Append-only double-entry ledger at `<dataDir>/ledger.jsonl`: `{ id, date, description, entries: [{ account, debit|credit, amount }], status, proposedBy, createdAt }`, validated for balanced debits/credits before any append, same discipline as Phase 2's event store.
- Define the `finance.bookkeeper` role: categorizes transactions into structured ledger-entry proposals (authority level `1` to propose, `3` to apply — issuing/applying a real ledger entry requires Decision).
- Wire `spacepacket`'s real product-revenue API (Cast/netdoctor/tokenize) as a read-only ledger-entry source, idempotent per ingested event (per Existing Files to Read First — confirm the real available endpoints before assuming general invoicing data exists there).

### Acceptance Criteria

- Proposing an unbalanced ledger transaction fails with a specific error naming the imbalance.
- Attempting to move a deal to `closed-won`/`closed-lost` directly, bypassing Phase 6's Decision flow, is rejected at the adapter/action call site itself.
- Re-ingesting the same `spacepacket` revenue event never creates a duplicate ledger proposal.
- At least one real transaction traceable back to a Phase 4-9 Opportunity (i.e. revenue that this system's own opportunity-discovery/pursuit work plausibly contributed to) is correctly categorized and posted.
