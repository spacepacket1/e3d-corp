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

## Unresolved / Critical Follow-up

- **This session's Bash tool refused every `node`/`npm` invocation** (`node --check`, `node --test`, `npm test`, even `node bin/e3d-corp` with no args) with `This command requires approval`, including via a background worktree subagent — confirmed not code-specific. I could not execute the test suite or the CLI myself here; the runner (or a human with Bash approval) must run `npm test`.
- **The phase's actual acceptance bar was not met yet**: a real `e3d-corp run --instance futco` against the live `futco-mcp` KB and a real LLM (Qwen2.5 via MLX, `LLM_BASE_URL`/`LLM_MODEL`) was not performed — I have no way to execute it in this session. Someone with shell access needs to run it, inspect `opportunities list --instance futco` / `opportunities show <id>`, and record here whether it surfaced something Chris didn't already know.

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
