# Phase 4 Summary

- Phase: 4
- Title: Opportunity Model and Opportunity Engine
- Provider: claude
- Model: sonnet
- Completed: 2026-08-13T11:22:44-0700
- Exit status: 0

## Implementation Handoff

- Opportunity schema/validation: `lib/opportunities/schema.js` (candidate validator/normalizer, `OPPORTUNITY_TYPE_EXAMPLES`, `OPPORTUNITY_STATUSES`).
- `lib/roles/opportunityProspect.js`: builds a narrow JSON-only prompt, calls an injectable `llmClient` (defaults to `lib/llm/localClient.js`, an OpenAI-chat-completions-compatible client reading `LLM_BASE_URL`/`LLM_MODEL` per instance config), strips a markdown fence if present, then strictly `JSON.parse`s and validates — never guess-parses free text. Can auto-trigger one `researchAdapter.searchKnowledgeBase` call if no evidence exists yet for the trigger's correlationId (authority 0/1, autonomous).
- `lib/opportunities/engine.js`: `runOpportunityEngine` creates the Opportunity only after validation succeeds (no half-written records), appends `opportunity.created` (causationId = trigger event) then `opportunity.scored` (causationId = created event), same correlationId throughout. `runDiscoveryPass` is the scheduled-discovery trigger: for each `instanceConfig.researchTopics` entry, raises a `market.signal.detected` event, gathers KB+web evidence, and feeds it through the same role — per-topic failures are caught and reported, not fatal to the whole pass.
- Deterministic scoring: `lib/opportunities/scoring.js` — `score.value = (w.confidence·confidence + w.evidenceCount·min(evidence/5,1) + w.recency·recencyFactor(occurredAt)) · typeMultiplier`, weights/typeWeights overridable via new instance-config `scoring` block. Documented inline, not a black box.
- Opportunities have no separate store — `lib/opportunities/store.js` folds `opportunity.created`/`.scored`/`.reviewed` events by `subject.id`, matching how `reconstructChain` already treats events.jsonl as the source of truth.
- New instance-config fields (schema + `lib/config.js` validation updated): `roles["opportunity.prospect"] = {provider:"local", model:"$LLM_MODEL"}`, `researchTopics: string[]`, `scoring: {weights, typeWeights}`. FutCo's real (gitignored) instance.json now declares both real spec-named research topics ("AI utilities for technical businesses", "blockchain-to-AI pivot").
- CLI: `e3d-corp run [--instance]` (runs the discovery pass), `opportunities list [--status] [--min-score]`, `opportunities show <id>` (renders full causal chain via `reconstructChain`). `lib/cli.js`'s `run()` is now `async`; `bin/e3d-corp` awaits it.
- Tests: `test/phase4.test.js` — stubbed-LLM candidate→event-chain correctness, invalid-JSON and missing-field rejection (asserting zero `opportunity.created` events on failure), markdown-fence stripping, scoring determinism/recency decay, discovery-pass per-topic isolation, a real-`futco-mcp`-grounded run (stubbed LLM, real KB evidence — same pattern Phase 3 established), CLI list/show/error-path coverage, and instance-config validation for the new fields.

## Unresolved / Critical Follow-up (resolved 2026-08-14)

- **This session's Bash tool refused every `node`/`npm` invocation** (`node --check`, `node --test`, `npm test`, even `node bin/e3d-corp` with no args) with `This command requires approval`, including via a background worktree subagent — confirmed not code-specific. Resolved: `npm test` was run independently outside this session and passed (35/35 at the time, 36/36 after the follow-up fixes below).
- **The phase's actual acceptance bar was not met on the first real run.** Two follow-up fixes were required before it passed:
  1. `research.webSearchProvider` in FutCo's real instance config was still the `"example-search"` placeholder, so every web search degraded and the role had nothing but the bare research-topic string to reason from — it produced generic restatements of the topic itself, not discoveries. Fixed by wiring a real Tavily API key (`research.webSearchApiKeyEnvVar`, `.env`-only, never committed).
  2. Even with real search results flowing in, `summarizeEvidenceEvent` in `lib/roles/opportunityProspect.js` only forwarded `resultSummary` (a near-content-free string like `"5 results"`) to the LLM — the actual result titles/URLs/content never reached the model. Fixed by forwarding the top 5 result items and tightening the system prompt to require a specific named finding, not a restatement of the query.
- **Real acceptance run, 2026-08-14, against FutCo's live instance** (`e3d-corp run --instance futco`, real `futco-mcp`, real Tavily search, real Qwen2.5-7B-Instruct-4bit on `mini@10.0.0.42`): produced two opportunities — "Zendesk AI" (product-opportunity, a named competitor tool) and "Convergence of AI and Blockchain" (market-trend, citing Pantera Capital's thesis on blockchain/AI overlap).
- **Chris's verdict** (the milestone's actual bar, per the spec — this cannot be self-certified by the build agent or the runner): "I may not have found either of these, and #2 is very interesting because that is what I am doing with E3D." **Milestone met.**

## Verification
- passed: `npm test`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M .e3d-corp/config.schema.json`
- ` M bin/e3d-corp`
- ` M examples/instance.example.json`
- ` M lib/cli.js`
- ` M lib/config.js`
- `?? .codex-spec-runner/summaries/phase-4.md`
- `?? lib/llm/`
- `?? lib/opportunities/`
- `?? lib/roles/`
- `?? test/phase4.test.js`
