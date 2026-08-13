# Feature Ticket: Build e3d-corp

## Overview

`e3d-corp` is a fleet of narrow-contract, continuously-trained LLM agents that collaborate to run a company — the same species of idea as `e3d-trade` (specialized agents proposing structured actions inside a deterministic pipeline), applied to company operations instead of a trading floor.

The repo itself is **not company-specific**. Like `e3d-pilot` is repo-agnostic and adopts any target repo through a config file, `e3d-corp` is company-agnostic and adopts any target company through an **instance config** plus a private, never-committed data directory. What makes a running deployment "FutCo" instead of a demo is entirely instance config — not a fork, not a code change.

**Primary goal of this build**: ship a working, public, demo-quality artifact — a legible team of agents (Prospector, Closer, Bookkeeper) visibly collaborating over a real pipeline, deployed with demo data, dashboarded, and continuously retraining itself — as another flagship example alongside `e3d-trade`, suitable for linking from `futco.ai`. FutCo itself has no revenue yet; this is not a system waiting to manage revenue that already exists, it's part of how FutCo demonstrates real capability to attract its first consulting engagements. Activating it against FutCo's actual business (real leads, real books, real deploy) is a deliberate second step (Tranche 2), not a prerequisite for shipping something real and working now.

Agents use whatever real resources they can reach to ground their proposals rather than reasoning in a vacuum: FutCo's own internal knowledge base (`futco-mcp`, already running) so proposals reflect what FutCo actually builds and has built, plus general web research for prospect/market context. This matters beyond usefulness — `e3d-applied`'s own convention is no fabricated capability claims, and an agent drafting a company's proposals must not invent capabilities FutCo doesn't have.

There is no paper-trading mode, unlike `e3d-trade` — real leads and real dollars once the FutCo instance activates, no synthetic economy to fall back on. Because of that, the **human-approval gate on every external or money-moving action is the sole safety backstop**, and it must be airtight from the first line of code, demo instance included: nothing that leaves the company (an email, a proposal) and nothing that touches money (issuing an invoice, marking a deal closed, recording a payment) fires without an explicit, logged human approval.

There is no automatic "hiring" (dynamically spinning up new agents based on load thresholds) in this spec. The roster (Prospector, Closer, Bookkeeper) is fixed, chosen up front the same way `e3d-trade` fixed its five agents — not derived from load data that doesn't exist yet for a company with no operating history. A human decides whether and when to add a fourth agent, informed by real logs this system produces.

The resulting product should support a one-sentence demonstration:

> A team of specialized agents — Prospector, Closer, Bookkeeper — collaborates over a real CRM and ledger to research prospects, draft proposals and invoices, and keep the books, learning from its own run history every week, proposing every consequential step for a human to approve and never firing one unattended.

---

## Product Goals

- Every consequential decision follows "AI suggests, code decides": each agent only ever produces structured JSON proposals; deterministic pipeline code validates, records, and (for internal writes) applies them. External/money-moving actions stop at a pending-approval record until a human explicitly approves.
- Ship something publicly demo-able and portfolio-quality before wiring any part of it to FutCo's real business — a working three-agent pipeline, a real (self-hosted, demo-data) CRM and ledger, a real training loop, and a dashboard, all runnable by a stranger against the shipped demo instance with zero configuration.
- Ground agent output in real information: FutCo's own knowledge base (`futco-mcp`) and web research, not just LLM prior knowledge, so proposals reflect what FutCo can actually deliver.
- Make `e3d-corp` adoptable by a stranger running their own company: writing one instance config plus pointing it at their own CRM/ledger/lead sources should work the same way the FutCo instance does.
- Make every agent action traceable to structured run data under the instance's private data directory, mirroring `e3d-pilot`'s per-run traceability contract.
- Keep the public repo demo-safe forever, even after FutCo's real instance activates: real business data must never land in the repo's git history or the public dashboard.
- Reuse `e3d-trade`'s "agent proposes structured JSON, deterministic code executes" convention by re-implementing it fresh (see Non-Goals on why not a shared package), and reuse the ecosystem's shared local-LLM runtime config (`LLM_BASE_URL` / `LLM_MODEL`) already used by `e3d-maps` and `e3d-trade`, pointed at the Qwen model served on `mini@10.0.0.42`.
- Make the weekly retraining loop real and demonstrable now, even though its training signal starts as demo-cycle logs rather than production volume.

---

## Non-Goals

- Do not build automatic "hiring" (threshold-triggered creation of new agents). The roster is fixed at three: Prospector, Closer, Bookkeeper. A future ticket may add a hiring mechanism once real cycle-load data exists.
- Do not build a paper-trading/sandbox economy. There's no clean simulated market to validate a "paper-closed" consulting deal against, unlike `e3d-trade`'s real on-chain prices. Real data, real approval gate, real accounts — activated for FutCo in Tranche 2, exercised against demo data in Tranche 1.
- Do not extract a shared npm package with `e3d-trade`. `e3d-sdk` already proved shared packages don't get adopted here (confirmed zero imports anywhere). Document the "propose JSON, code executes" pattern as a short written convention (`docs/agent-pipeline-pattern.md`) and hand-implement it fresh, the way `e3d-tokenize` copied `e3d-netdoctor`'s wallet-mint plumbing instead of sharing a package.
- Do not modify `e3d-trade`, `e3d-pilot`, `spacepacket`, `e3d-applied`, or `futco-mcp` in this spec. All integration is read (and, for CRM/ledger, write to a system this repo owns) via existing APIs — no direct runtime imports, matching the ecosystem's integration-boundary rule.
- Do not build a full GAAP-compliant accounting suite. The ledger is a lightweight, deterministic, append-only double-entry transaction log.
- Do not build a new scheduler. Cadence is a cron/launchd entry calling `e3d-corp run`, the same pattern `e3d-pilot` uses.
- Do not fire any external/consequential action — send a real email, issue a real invoice, mark a deal closed-won, record a payment as accepted, post publicly — without an explicit, logged human approval. No config flag bypasses this for any action type in this spec, demo instance or not.
- Do not commit real business data anywhere in this repo's history: no real client names, deal amounts, revenue figures, CRM exports, or credentials, ever, even after Tranche 2 activates. All of that lives in a private, gitignored instance data directory outside the tracked tree.
- Do not require a new language runtime beyond Node.js (matching `e3d-trade`) plus what the ecosystem already accepts (`jq`, `curl`, `git`, Docker for the self-hosted CRM, Python for LoRA training scripts, matching `e3d-trade`'s own `training/` stack).
- Do not wire real lead intake from `e3d-applied` or real revenue ingestion from `spacepacket` in Tranche 1. Both adapters are built and tested against fixtures in Tranche 1; pointing them at the real, live surfaces is a Tranche 2 activation step, not a Tranche 1 build step.
- Do not build multi-model negotiation for high-stakes decisions in this spec. It needs real evidence that single-model proposals are wrong often enough, or costly enough when wrong, to justify the added latency/cost — evidence that doesn't exist until the FutCo instance has run for real. Documented as a named Tranche 2+ follow-up, not detailed here.

---

## Rollout Sequencing

### Tranche 1 — build now (demo instance only)

1. Phase 1 — Repo scaffold and instance config contract
2. Phase 2 — Ledger (deterministic double-entry core)
3. Phase 3 — CRM integration (self-hosted, demo data)
4. Phase 4 — Approval gate and audit trail
5. Phase 5 — Research/tools layer (`futco-mcp`, web search)
6. Phase 6 — Agent roster: Prospector, Closer, Bookkeeper
7. Phase 7 — Main loop, fixture-based lead/transaction intake, and cadence
8. Phase 8 — Product-revenue ingestion adapter (built, exercised via fixtures)
9. Phase 9 — Dashboard (demo-safe public mode; real-data mode built but never deployed against real data in this tranche)
10. Phase 10 — Weekly LoRA retraining pipeline (trains on demo-cycle logs)

Every phase in Tranche 1 is built once and works for any instance via config — the demo/real split is which instance config gets used, not different code paths. Tranche 1 ships with only the demo instance ever actually run or deployed.

### Tranche 2 — activate for FutCo (defer until Tranche 1 has shipped and been demoed)

11. Phase 11 — Activate the FutCo instance: real (private) instance config, real `e3d-applied` lead intake, real `spacepacket` revenue ingestion, real deploy on `mini@10.0.0.42`, real approval workflow used in anger.
12. Phase 12 — Multi-model negotiation for high-stakes decisions (specified in a future ticket once Phase 11 produces real decision volume to justify it).

A future ticket may specify a hiring/scaling mechanism once Phase 11 has produced real cycle-load data — explicitly out of scope for both tranches here.

---

## Existing Files to Read First

- `/Users/cbloom/e3d-trade/scout/AGENTS.md`, `harvest/AGENTS.md`, `risk/AGENTS.md`, `executor/AGENTS.md` — the narrow-contract agent pattern Phase 6's roster follows in spirit.
- `/Users/cbloom/e3d-trade/docker-compose.yml` and `training/` — precedent for self-hosted service deployment and the weekly LoRA retraining pattern (Phase 10).
- `/Users/cbloom/e3d-pilot/docs/build-e3d-pilot.md` (Phase 1: run-lifecycle; Phase 2: provider adapter contract) — the config-contract and provider-abstraction conventions reused in pattern here, not by import.
- `/Users/cbloom/e3d-pilot/lib/providers/` — existing provider adapter scripts to copy the pattern from, not import from.
- `futco-mcp`'s tool surface (`list_repos`, `get_repo`, `search_knowledge_base`) — read its README/server.js before Phase 5 so the research adapter calls it correctly as an MCP client.
- FutCo's `e3d-applied` contact/lead capture implementation — read before Phase 11 (not needed for Tranche 1, which uses fixtures) to confirm the real integration shape ahead of time.
- `spacepacket`'s payments API surface — read before Phase 8/11 to confirm what revenue events it can actually expose read-only; do not assume general invoicing data exists there.

---

## Shared Constraints

### Company-agnostic core, instance-specific data

- All company-identifying configuration lives in `.e3d-corp/instance.json`, analogous to `e3d-pilot`'s per-target-repo `.e3d-pilot/config.json`.
- All real, sensitive instance data lives under a private, gitignored `.e3d-corp/instance/<instance-name>/`. Nothing under this path is ever committed.
- The public repo ships `examples/instance.demo.json` plus seed/demo ledger, CRM, and lead/transaction fixtures under `examples/seed-data/` so a stranger can run the whole loop with zero configuration.
- FutCo's real instance config and real data (Tranche 2) live outside the repo entirely on `mini@10.0.0.42` and are never pushed.

### Human authority

- No action in this spec sends a real external communication, issues a real invoice, records a real payment, or marks a deal closed-won/closed-lost without a human explicitly approving a specific pending-approval record first (Phase 4) — true for the demo instance as much as for FutCo's real one.
- Internal writes (CRM field/stage updates, ledger draft entries pending approval, drafted-but-unsent content, research notes) are autonomous.

### Stack

- Node.js (ESM), matching `e3d-trade`'s stack.
- CRM: [Twenty](https://github.com/twentyhq/twenty), self-hosted via Docker Compose (matching `e3d-trade`'s Docker Compose precedent), behind an adapter interface so a different OSS CRM could be substituted without touching pipeline code.
- Ledger: hand-rolled, deterministic, append-only double-entry JSON-lines transaction log (Node.js only, no `beancount`/`hledger` CLI dependency).
- LLM: local OpenAI-compatible endpoint, `LLM_BASE_URL` / `LLM_MODEL` env vars shared with `e3d-maps`/`e3d-trade`'s convention — Qwen2.5 via MLX on `mini@10.0.0.42`, the same machine `e3d-corp` runs on.
- Training: Python LoRA fine-tuning scripts under `training/`, matching `e3d-trade`'s stack and weekly-schedule convention.
- Deploy: PM2 process(es) on `mini@10.0.0.42`, matching the ecosystem's PM2 convention.
- Research tools: an MCP client against `futco-mcp` (already running) and a pluggable web-search adapter.

### Traceability

- Every agent proposal, every approval/rejection decision, and every fired action is recorded under `.e3d-corp/instance/<instance-name>/runs/<run-id>/` as structured JSON, mirroring `e3d-pilot`'s `.e3d-pilot/runs/<run-id>/` contract.

---

## Phase 1 — Repo Scaffold and Instance Config Contract

<!-- runner:model=codex:gpt-5.4-mini -->

### Requirements

- This spec file (`docs/build-e3d-corp.md`) already exists in the working tree; the repo is already `git init`'d. Add `LICENSE`, `.gitignore` (must ignore `.e3d-corp/instance/`, `node_modules/`, `.env`), `README.md` stub per the Overview, `package.json` (ESM, Node 18+), `bin/e3d-corp` entrypoint.
- Define `.e3d-corp/instance.json` schema (`config.schema.json` + `e3d-corp config validate <instance-config-path>`). Fields: `name`, `dataDir`, `crm: { kind, apiUrl, apiKeyEnvVar }`, `leadSources` (array; Phase 7 defines the fixture-based first entry, Phase 11 adds `e3d-applied`), `llm: { baseUrlEnvVar, modelEnvVar }`, `research: { futcoMcpUrl, webSearchProvider }`, `approval: { notify: { email, command } }`, `revenueIngestion: { spacepacketApiUrl }` (optional).
- `bin/e3d-corp --help` documents every subcommand this spec adds, even as `not yet implemented` stubs for later-phase commands.
- Add `examples/instance.demo.json` pointing at seed data (later phases add the files it references).

### Acceptance Criteria

- `node --check bin/e3d-corp` passes.
- `e3d-corp config validate <path-without-instance.json>` fails clearly, naming the missing file.
- `e3d-corp config validate examples/instance.demo.json` passes.
- `.gitignore` correctly ignores `.e3d-corp/instance/`.

## Phase 2 — Ledger (Deterministic Double-Entry Core)

<!-- runner:model=claude:sonnet -->

### Requirements

- Append-only JSON-lines transaction log at `<dataDir>/ledger.jsonl`: `{ id, date, description, entries: [{ account, debit|credit, amount }], status: "pending"|"approved"|"applied", proposedBy, createdAt }`.
- A pure function validates double-entry balance before any entry may be appended in any status; unbalanced transactions are rejected with a clear error naming the imbalance amount.
- `e3d-corp ledger propose <transaction.json>` appends with `status: "pending"`. `e3d-corp ledger apply <id>` transitions an already-`approved` transaction to `applied` — the only way a transaction becomes real.
- `e3d-corp ledger report [--instance <name>]` renders a human-readable balance sheet / P&L from all `applied` entries.
- Seed `examples/seed-data/ledger.jsonl` with fake, clearly-labeled demo transactions.

### Acceptance Criteria

- Proposing an unbalanced transaction fails with a specific error.
- `ledger apply` refuses a transaction not in `approved` status.
- `ledger report` against the seed ledger produces a coherent, balanced summary.
- Concurrent `ledger propose` calls do not corrupt the file.

## Phase 3 — CRM Integration

<!-- runner:model=codex:gpt-5.4-mini -->

### Requirements

- `lib/crm/adapter.js` defines the interface (`getContact`, `upsertContact`, `listDeals`, `createDeal`, `updateDealStage`, `addNote`); `lib/crm/twenty.js` implements it against Twenty CRM per `instance.json`'s `crm` config, with zero Twenty-specific types leaking into pipeline code.
- Internal writes (contact upsert, notes, non-terminal deal-stage moves) apply directly — autonomous.
- Marking a deal `closed-won`/`closed-lost` is terminal and external-facing: it must go through the approval gate (Phase 4), never apply directly.
- `docker-compose.yml` to run Twenty CRM locally for development/demo.
- Seed `examples/seed-data/crm-seed.json` with fake demo contacts/deals importable into the demo Twenty instance.

### Acceptance Criteria

- `lib/crm/adapter.js` has zero Twenty-specific references outside `lib/crm/twenty.js`.
- Against a locally running demo Twenty instance, `upsertContact` + `createDeal` + non-terminal `updateDealStage` succeed end-to-end.
- Attempting to move a deal to `closed-won`/`closed-lost` directly is rejected by the adapter layer itself.

## Phase 4 — Approval Gate and Audit Trail

<!-- runner:model=claude:sonnet -->

Build and test this against synthetic proposals before Phase 6's agents exist.

### Requirements

- Every action type requiring approval is proposed as `<dataDir>/runs/<run-id>/proposals/<id>.json`: `{ id, type, payload, proposedBy, createdAt, status: "pending"|"approved"|"rejected", decidedBy, decidedAt, reason }`.
- `e3d-corp status [--instance <name>]` lists pending proposals with enough summary detail (type, amount if financial, recipient if external) to decide without opening raw JSON.
- `e3d-corp approve <id>` / `e3d-corp reject <id> --reason <text>` are the only ways status changes from `pending`. No auto-approve mode, config flag, or env var bypasses this for any action type in this spec.
- Approving a proposal does not itself fire the action — it unblocks the specific downstream apply step (`ledger apply`, CRM terminal-stage update, Phase 7's send-content step). This two-step separation means an approval can never cascade into an unintended side effect.
- Every proposal, decision, and fired action is appended to `<dataDir>/runs/<run-id>/audit.jsonl`.
- Optional best-effort notification (`approval.notify`) fires on new pending proposals; failure to notify never blocks CLI approvability.

### Acceptance Criteria

- A hand-crafted test proposal of each action type can be approved or rejected via CLI, and only an approved one can be applied.
- `e3d-corp status` against 3 pending proposals of different types renders all 3 correctly.
- Applying a `pending` or `rejected` proposal fails clearly at every apply-step call site, not just the CLI layer.
- `audit.jsonl` for a full propose→approve→apply cycle contains all three events in order with consistent `id` correlation.

## Phase 5 — Research/Tools Layer

<!-- runner:model=codex:gpt-5.4-mini -->

Gives agents access to real information instead of reasoning in a vacuum.

### Requirements

- `lib/research/adapter.js` defines the interface (`searchKnowledgeBase(query)`, `getRepoInfo(name)`, `webSearch(query)`); `lib/research/futcoMcp.js` implements the first two as an MCP client against the running `futco-mcp` server's `search_knowledge_base`/`get_repo`/`list_repos` tools; `lib/research/webSearch.js` implements the third against a configurable provider (`research.webSearchProvider` in instance config).
- Every research call and its result is logged under `<dataDir>/runs/<run-id>/research-calls/` for traceability and later use as training signal (Phase 10).
- If `futco-mcp` or the web-search provider is unreachable, the adapter reports a distinct, documented "unavailable" result rather than throwing — callers (Phase 6 agents) must degrade gracefully (proceed without that grounding, noting it in the proposal) rather than fail the whole cycle.

### Acceptance Criteria

- Against a mocked MCP server, `searchKnowledgeBase`/`getRepoInfo` return correctly parsed results.
- Against a mocked web-search provider, `webSearch` returns correctly parsed results.
- With both providers unreachable, calls return the documented unavailable result, not an exception, and this is logged.

## Phase 6 — Agent Roster: Prospector, Closer, Bookkeeper

<!-- runner:model=claude:sonnet -->

Three narrow-contract agents, each calling the shared local LLM (`LLM_BASE_URL`/`LLM_MODEL`) with task-specific prompts, each producing only structured JSON matching a documented schema for its task type — never free text the pipeline has to guess-parse.

### Requirements

- **Prospector** (`lib/agents/prospector.js`) — discovery/research only. `qualifyLead(lead)`: uses the Phase 5 research layer to ground the lead against FutCo's real capabilities and any public info about the prospect, produces a structured qualification (`{ fit, reasoning, suggestedNextStep, evidence[] }`). Never drafts outbound content, never touches money, never writes to the CRM beyond a note/qualification field (autonomous, internal).
- **Closer** (`lib/agents/closer.js`) — drafting and deal-progression only. `draftProposal(qualifiedLead)` / `draftInvoice(deal)`: produces structured content plus always creates a Phase 4 pending-approval record of type `send-content`/`issue-invoice` — never sends or issues anything itself. `proposeDealStage(deal, stage)`: non-terminal stages apply directly (autonomous); terminal stages (`closed-won`/`closed-lost`) always go through the approval gate.
- **Bookkeeper** (`lib/agents/bookkeeper.js`) — categorization and reporting only. `categorizeTransaction(rawTransaction)`: produces a structured ledger-entry proposal (`status: "pending"`, via `ledger propose`) — never applies an entry, never touches the CRM.
- Write `docs/agent-pipeline-pattern.md` documenting the "agent proposes structured JSON, deterministic code validates and executes" convention as adapted from `e3d-trade`, explicitly noting it's a copied pattern, not a shared dependency.
- Every LLM call and its raw + parsed output is logged under `<dataDir>/runs/<run-id>/agent-calls/`, tagged by agent name, for Phase 10's training signal.
- If `LLM_BASE_URL` is unreachable, each agent reports itself unavailable via a distinct, documented exit code rather than crashing or silently no-op'ing.

### Acceptance Criteria

- Against a stubbed LLM endpoint returning fixture JSON per task type, all three agents' functions parse correctly and produce the right downstream write (autonomous CRM/ledger write, or Phase 4 pending-approval record).
- Malformed LLM output is rejected with a clear error and never reaches the ledger, CRM, or approval queue in a half-applied state.
- Running any agent with `LLM_BASE_URL` unset/unreachable exits with the documented unavailable code, not a stack trace.
- `agent-calls/` logs are correctly tagged per agent (`prospector`/`closer`/`bookkeeper`), distinguishable for Phase 10.

## Phase 7 — Main Loop, Fixture-Based Intake, and Cadence

<!-- runner:model=codex:gpt-5.4-mini -->

### Requirements

- `e3d-corp run --instance <name>` executes one full cycle: pull new leads from configured `leadSources` → Prospector.qualifyLead → (for qualified leads needing a next step) Closer.draftProposal; pull unprocessed transactions → Bookkeeper.categorizeTransaction; exit. No built-in scheduler — cadence is a cron/launchd entry calling `e3d-corp run`.
- Tranche 1's only `leadSources`/transaction-source adapter is fixture-based: reads from `examples/seed-data/leads.json` / a configurable local file for demo/dev use. The real `e3d-applied` adapter is Phase 11, not built here.
- A new run-id is created per invocation under `<dataDir>/runs/`, collision-safe, with a "latest run" pointer, mirroring `e3d-pilot`'s run lifecycle.
- `e3d-corp run` is idempotent per lead/transaction: re-running against the same source data does not create duplicate proposals for already-processed items (track processed-item IDs under the instance data dir).

### Acceptance Criteria

- A fixture-based run (demo leads/transactions, mocked LLM) processes each item exactly once, producing the expected mix of autonomous writes and pending approvals.
- Running `e3d-corp run` twice against the same fixture data produces zero duplicate proposals on the second run.
- `e3d-corp run` against an instance with no configured sources completes cleanly with an explicit "nothing to do" status.

## Phase 8 — Product-Revenue Ingestion Adapter

<!-- runner:model=codex:gpt-5.4-mini -->

Built and tested against fixtures in this tranche; pointed at real `spacepacket` data in Phase 11.

### Requirements

- `lib/revenue/spacepacket.js` reads revenue events from `spacepacket`'s API (read-only, HTTP, no direct import) per `instance.json`'s `revenueIngestion.spacepacketApiUrl`.
- Each ingested event becomes a Bookkeeper-style ledger transaction proposal, categorized by source product — still requires approval before `applied`, same as any other ledger entry.
- Ingestion is idempotent: re-ingesting the same event never creates a duplicate proposal (track ingested event IDs under the instance data dir).
- Opt-in via `revenueIngestion` config field; an instance without it skips this step entirely.

### Acceptance Criteria

- Against fixture `spacepacket` API responses, ingestion produces one correctly-categorized pending ledger proposal per event.
- Re-running against the same fixtures produces zero duplicate proposals.
- An instance config with no `revenueIngestion` field skips this step without error.

## Phase 9 — Dashboard

<!-- runner:model=claude:sonnet -->

The actual portfolio artifact.

### Requirements

- Minimal web dashboard (hand-rolled HTTP server, matching `e3d-trade`'s `server.js` pattern) showing: pending approvals queue, recent activity per agent (Prospector/Closer/Bookkeeper), ledger P&L summary, CRM pipeline snapshot, and the latest training run's summary (Phase 10).
- Default/public mode serves the **demo instance's data only**, safe to deploy publicly with zero configuration — this is the mode actually deployed in Tranche 1.
- Real-instance mode requires basic auth (credentials via env var, never committed); running it against a non-demo instance with no auth configured must refuse to start.
- Dashboard is read-only: no approve/reject action is exposed through the web UI — approval stays a deliberate CLI action (Phase 4).

### Acceptance Criteria

- Running the dashboard against `examples/instance.demo.json` with no auth starts successfully and serves demo data.
- Running the dashboard against a non-demo instance config with no auth env vars configured refuses to start, naming the missing credential.
- No route or button in the dashboard can change a proposal's status.

## Phase 10 — Weekly LoRA Adapter Retraining

<!-- runner:model=claude:sonnet -->

Mirrors `e3d-trade`'s `training/` pattern. Trains on Phase 6/7's demo-cycle logs in this tranche — a real, working mechanism, even though the training signal is small/synthetic until Phase 11 activates FutCo's real instance.

### Requirements

- Python scripts under `training/` fine-tune a LoRA adapter against `<dataDir>/runs/*/agent-calls/`, using approved-vs-rejected proposal outcomes (Phase 4's audit trail) as training signal, keyed per agent (Prospector/Closer/Bookkeeper may warrant separate adapters or one shared adapter — implementer's call, document the choice).
- A weekly cron/launchd entry (documented, not built into `e3d-corp` itself, matching the no-built-in-scheduler constraint) invokes the training script.
- Adapter versions are recorded (which adapter version was active for which run) so the dashboard (Phase 9) can show current adapter version and training history.
- Training against fewer than a documented minimum number of logged decisions is a clean no-op with a clear message, not a crash or a meaningless training run on a handful of examples.

### Acceptance Criteria

- Against a fixture set of `agent-calls`/`audit.jsonl` logs meeting the minimum threshold, the training script runs end-to-end and produces a versioned adapter artifact.
- Against a fixture set below the minimum threshold, the script exits cleanly with a clear "not enough data" message.
- The dashboard correctly displays the current adapter version after a training run.

---

## Phase 11 — Activate the FutCo Instance (Tranche 2)

<!-- runner:model=claude:sonnet -->

Do not begin until Tranche 1 has shipped, been demoed, and a human has explicitly decided to proceed.

### Requirements

- Create FutCo's real instance config and private data directory on `mini@10.0.0.42`, outside the repo, never committed.
- Point the `leadSources` adapter at `e3d-applied`'s real contact-form lead delivery mechanism (read its actual implementation first, per Existing Files to Read First — do not assume a webhook shape that doesn't exist).
- Point `revenueIngestion` at `spacepacket`'s real API for FutCo's live product revenue (Cast/netdoctor/tokenize).
- Deploy via PM2 on `mini@10.0.0.42`, pointed at the local Qwen endpoint already serving `e3d-trade`.
- Confirm the approval-gate workflow (Phase 4) works in practice with a human actually approving/rejecting real proposals before declaring this phase done — not just passing fixture-based acceptance criteria from Tranche 1.

### Acceptance Criteria

- A real lead submitted through `e3d-applied` produces a real Prospector qualification and, where warranted, a real Closer-drafted proposal sitting in the approval queue.
- A real FutCo product-revenue event from `spacepacket` produces a real pending ledger entry.
- At least one full real propose→human-approve→apply cycle is completed and visible in `audit.jsonl` before this phase is considered complete.
