# Phase 3 Summary

- Phase: 3
- Title: Research/Evidence Layer
- Provider: codex
- Model: gpt-5.4-mini
- Completed: 2026-08-13T10:54:58-0700
- Exit status: 0

## Implementation Handoff

- Added `lib/research/adapter.js` to wrap research calls and append every result as `evidence.gathered` with query, summary, degradation flag, causationId, and correlationId.
- Added `lib/research/futcoMcp.js` plus `lib/research/mcpTransport.js` for MCP tool calls against FutCo knowledge-base tools (`search_knowledge_base`, `get_repo`), with graceful unavailable results instead of throws.
- Added `lib/research/webSearch.js` for configurable HTTP-based web search providers, including documented unavailable handling.
- Added `lib/event-sources/e3dApplied.js` to translate e3d-applied contact submissions into `lead.received` events with fresh correlationIds.
- Wired the private FutCo instance config to include the first real event-source entry for e3d-applied lead capture.
- Added `test/phase3.test.js` covering real FutCo KB lookups, repo parsing, web-search provider handling, unavailable fallbacks, evidence logging, and lead ingestion.
- Decision: because no HTTP MCP bridge is listening on `127.0.0.1:4110` in this workspace, the FutCo adapter falls back to the real local `futco-mcp/server.js` stdio server when the config URL is the default local endpoint.
- Decision: web search treats non-HTTP provider names as unavailable; the positive test path uses an in-process fetch stub to avoid sandbox socket binding limits.
- Verification run: `node --test test/phase3.test.js`, `node --check` on new modules, and full `npm test`.
- Result: all tests passed.
- Follow-up for Phase 4: consume `evidence.gathered` chains and the new lead source from the opportunity engine.

## Verification
- passed: `npm test`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- `?? .codex-spec-runner/summaries/phase-3.md`
- `?? lib/event-sources/`
- `?? lib/research/`
- `?? test/phase3.test.js`
