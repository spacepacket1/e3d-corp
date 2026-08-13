# Phase 2 Summary

- Phase: 2
- Title: Company Event Store
- Provider: claude
- Model: sonnet
- Completed: 2026-08-13T10:34:23-0700
- Exit status: 0

## Implementation Handoff

- Added `lib/events/store.js`: `appendEvent(dataDir, event)` validates `type`, `source`, `subject: {type, id}`, `payload`, `correlationId` (required, non-empty), and `causationId` (null or a non-empty string that must resolve to an existing event's `id`, checked by scanning `events.jsonl`); generates `id`/`occurredAt` when absent; appends one JSON line via `fs.appendFileSync(..., { flag: 'a' })`. `queryEvents(dataDir, { type, subject, correlationId, since })` reads and filters, always returned sorted by `occurredAt` ascending.
- Added `lib/events/chain.js`: `reconstructChain(dataDir, correlationId)` is a thin wrapper over `queryEvents({ correlationId })`.
- Added `loadInstance(instanceName)` and `instanceConfigPath(instanceName)` to `lib/config.js`, resolving `.e3d-corp/instance/<name>/instance.json` and an absolute `dataDir`. This is the pattern later phases (`run`, `opportunities`, etc.) should reuse for instance/data-dir resolution.
- Wired `e3d-corp event add --type <type> --source <source> --payload <json> [--correlation <id>] [--causation <id>] [--instance <name>] [--subject-type <type>] [--subject-id <id>]` and `e3d-corp event log [--correlation <id>] [--since <date>] [--instance <name>]` into `lib/cli.js`. `--instance` defaults to `futco`. `event add` generates a fresh `correlationId` via `crypto.randomUUID()` when `--correlation` is omitted, and defaults `subject` to `{ type: <event type>, id: <fresh uuid> }` when not given explicitly.
- Updated CLI help text (previously "Phase 1 implements only `config validate`") to reflect implemented commands; updated the corresponding assertion in `test/phase1.test.js`.
- Decision: `appendEvent`/`queryEvents`/`reconstructChain` take `dataDir` as an explicit first argument rather than reading global state — keeps the store stateless/testable and matches how `loadInstanceConfig` already worked in Phase 1. Later phases should pass `dataDir` from `loadInstance(name)`.
- Concurrency: relies on POSIX O_APPEND single-write atomicity (no lock file) — documented inline in `store.js`. Adequate for this spec's local single-machine scope.
- Tests added in `test/phase2.test.js`: `appendEvent` id/occurredAt generation, required-field rejection, causationId-must-exist rejection and acceptance, `queryEvents` filters, `reconstructChain` on a hand-crafted 4-event chain (and an out-of-order-append ordering check), CLI `event add`/`event log` round-trip proving shared `correlationId` chaining, CLI payload-JSON-error and causationId-error surfacing, and a concurrency test spawning 12 parallel child processes running `event add` against the same instance, asserting `events.jsonl` ends up with exactly 12 valid, uniquely-`id`'d lines.

## Verification
- passed: `npm test`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M lib/cli.js`
- ` M lib/config.js`
- ` M test/phase1.test.js`
- `?? .codex-spec-runner/summaries/phase-2.md`
- `?? lib/events/`
- `?? test/phase2.test.js`
