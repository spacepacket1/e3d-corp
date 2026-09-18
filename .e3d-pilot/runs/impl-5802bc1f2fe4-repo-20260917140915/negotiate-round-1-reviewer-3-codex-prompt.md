You are reviewer codex in round 1 of the negotiate loop.
Read the current draft below as the only source of truth.

Respond using exactly this format, with no other text before or after it,
no markdown heading, comment, or bold syntax around any of these lines:

---STATUS---
status: approved
reason: <one-line reason>

Use "status: revise" in place of "status: approved" if the draft needs changes.
When status is revise, put a fenced ```spec block directly after the reason line,
containing the full replacement spec (not a diff or a summary of changes), then
nothing else.

The line "---STATUS---" must appear verbatim and on its own line; it is a fixed
parser marker, not a section title to be reworded or restyled.

Current draft:

# Inbound Payment Request Risk Guard Prototype

## Overview

Add a minimal inbound payment-request guard to the existing event-sourced runtime. A CLI command records a consequential request, invokes a structured `risk.assess` role with relevant vendor history from the event log, and creates a pending level-3 `flag-payment-request` Proposal containing a `HOLD`, `APPROVE`, or `CHECK` recommendation.

The prototype stops at Proposal creation. It does not execute payments or register an action executor.

## Goals

- Accept payment requests through a dedicated CLI command.
- Preserve each request as an append-only Company Event.
- Assess requests through the configured `risk.assess` provider.
- Ground assessments in relevant existing event-log history.
- Strictly validate the role’s structured verdict.
- Create a pending Proposal whose authority level is derived from policy.
- Exercise the complete Event-to-Proposal path in automated tests.

## Non-Goals

- Gmail, Drive, accounting, banking, or payment-provider integrations.
- Payment execution or an executor for `flag-payment-request`.
- Web UI, README, or private instance-config changes.
- Decision, confirmation, Action, Outcome, or Experience workflow changes.
- Automatic approval based on an `APPROVE` verdict.
- New evidence providers, databases, or policy mechanisms.
- Provider completion/failure events, budget reservations, or multi-provider fan-out.
- General-purpose fraud detection or production-grade risk scoring.

## Existing Files

- `lib/cli.js` implements command routing, flag parsing, instance loading, and event creation.
- `lib/events/store.js` provides append-only event storage and event queries.
- `lib/roles/communicator.js` demonstrates configured-provider resolution, strict JSON role output, Proposal creation, and injectable LLM clients.
- `lib/authority/policy.js` is the authoritative action-type-to-authority-level mapping.
- `lib/proposals/create.js` derives authority from policy and appends `proposal.created`.
- `examples/instance.example.json` demonstrates role-to-provider configuration.
- Existing Node test suites use temporary data directories and injected provider clients.

## Shared Constraints

- Keep the implementation within 8 changed files and 650 changed lines.
- Change only these files unless a listed requirement cannot be met otherwise: `lib/authority/policy.js`, `lib/roles/riskAssess.js`, `lib/cli.js`, `examples/instance.example.json`, `test/riskAssess.test.js`.
- Models may return structured recommendations but must never append Decisions or execute Actions.
- `authorityLevel` must be derived exclusively through the existing authority policy.
- Every submitted request with a valid role response must produce exactly one pending Proposal regardless of whether the verdict is `HOLD`, `APPROVE`, or `CHECK`.
- Treat an `APPROVE` verdict only as advisory text inside a pending Proposal.
- Do not register an action executor for `flag-payment-request`.
- Reject malformed CLI input before writing any event.
- Reject malformed model output without creating a Proposal. The already-appended `payment-request.received` event stays in the log.
- Do not invent evidence identifiers or include unrelated event history in the model prompt.
- Preserve the existing event, Proposal, provider-registry, and instance-config conventions.
- Do not add dependencies or modify private instance data.

## Canonical Shapes

Normalize vendor IDs by trimming surrounding whitespace and lowercasing. Store and match that normalized value. Trim vendor name, description, and optional reference without changing case. Normalize currency by trimming and uppercasing.

The `payment-request.received` event MUST use:

- `type`: `payment-request.received`
- `source`: `cli`
- `subject`: `{ type: "payment-request", id: <generated requestId> }`
- `causationId`: `null`
- `correlationId`: a newly generated UUID
- `payload`:
  - `requestId`: the same UUID as `subject.id`
  - `vendorId`: normalized vendor ID
  - `vendorName`: trimmed vendor name
  - `amount`: a finite number greater than zero
  - `currency`: three-letter uppercase code
  - `description`: trimmed non-empty string
  - `dueDate`: present only when the caller supplied a valid due date; store the provided string
  - `reference`: present only when the caller supplied a non-empty reference; store the trimmed string

Vendor-history matching is exact and field-based, never substring search over serialized events. An event is relevant when all of the following are true:

- Its `id` differs from the request event’s `id`.
- It predates the request event: `occurredAt` is earlier, or `occurredAt` is equal and it appears earlier in log order.
- The request’s normalized `vendorId` equals either `normalizeVendorId(event.subject.id)` or `normalizeVendorId(event.payload.vendorId)` when that payload field is a string.

Select at most the 20 newest relevant events, newest first by `occurredAt` descending, with log order (later in file is newer) as the tie-break. The allowed evidence ID set is the request event ID plus those selected prior event IDs.

The accepted model response MUST be exactly one JSON object with only these keys:

- `verdict`: `HOLD`, `APPROVE`, or `CHECK`
- `reasoning`: a non-empty string
- `riskFactors`: an array of non-empty strings; an empty array is allowed
- `evidenceEventIds`: an array of unique IDs from the allowed evidence ID set; an empty array is allowed

Reject extra keys, empty output, invalid JSON, unsupported verdicts, missing fields, incorrect field types, blank strings, duplicate evidence IDs, and IDs that were not supplied to the role. Strip a wrapping markdown fence before `JSON.parse`, matching existing role JSON parsing.

After validation, `createProposal` MUST be called with:

- `type`: `flag-payment-request`
- `causationId`: the request event ID
- `correlationId`: the request event’s correlation ID
- `instanceConfig`: the loaded instance config, so existing authority notification still runs
- `proposedBy`: `{ role: "risk.assess", provider, model }` from the configured, resolved provider — never from model output
- `payload`:
  - `requestEventId`
  - `request`: the normalized request payload fields listed above
  - `assessment`: `{ verdict, reasoning, riskFactors, evidenceEventIds }` after trim/normalization

Do not add a dedicated payload schema file. Generic Proposal payload handling is enough.

## Phase 1 - Payment Request Intake and Risk Assessment

<!-- runner:model=codex:gpt-5.4 -->
<!-- pilot:touches=lib/authority/policy.js -->
<!-- pilot:touches=lib/roles/riskAssess.js -->
<!-- pilot:touches=lib/cli.js -->
<!-- pilot:touches=examples/instance.example.json -->
<!-- pilot:touches=test/riskAssess.test.js -->
<!-- runner:read=README.md -->
<!-- runner:read=lib/roles/communicator.js -->
<!-- runner:read=lib/proposals/create.js -->
<!-- runner:read=lib/events/store.js -->
<!-- runner:verify=npm install && npm run check -->

### Requirements

1. Extend `ACTION_POLICY` in `lib/authority/policy.js` with `flag-payment-request` at `AUTHORITY_LEVELS.FINANCIAL_ACTION`. Set `ACTION_POLICY_VERSION` to `3`. Do not change existing action-type mappings.

2. Add `lib/roles/riskAssess.js` implementing the `risk.assess` role. Export `normalizeVendorId`, `selectVendorHistory`, `parseAssessmentJson`, `normalizeAssessment`, and `runRiskAssess`.

3. `runRiskAssess({ dataDir, instanceConfig, requestEvent, llmClient })` loads history from the event store, builds the prompt, invokes the provider, validates the response against the allowed evidence IDs, and creates the Proposal. It must not append the `payment-request.received` event.

4. This role is single-provider and creates exactly one Proposal. Read `instanceConfig.roles["risk.assess"].provider`. If the value is an array, use only the first name. Resolve that provider through the existing registry. Support an injected `llmClient` function for deterministic tests, following existing role conventions. If the role config is missing, throw a clear error before any provider call.

5. Build a bounded role prompt containing:

   - The submitted `payment-request.received` event.
   - At most the 20 newest relevant prior events, selected as specified above.
   - The exact allowed evidence event IDs.
   - Instructions that `APPROVE` is only a recommendation and cannot approve or execute anything.
   - Instructions to use `CHECK` when evidence is insufficient or ambiguous and never invent facts or evidence IDs.

6. The role must never append a Decision, invoke `decideProposal`, call `confirmAndExecute`, or register or invoke an action executor. Do not emit provider completion/failure events in this prototype.

7. Add a CLI command with this public shape:

   `request submit --instance <name> --vendor-id <id> --vendor-name <name> --amount <number> --currency <code> --description <text> [--due-date <iso>] [--reference <text>]`

8. Validate required flags before loading the instance or writing events:

   - `--instance`, `--vendor-id`, `--vendor-name`, and `--description` are present and non-empty after trim.
   - `--amount` parses with `Number(...)` to a finite value greater than zero; reject blank, non-numeric, zero, and negative values.
   - `--currency` normalizes to uppercase and must match `^[A-Z]{3}$`.
   - Optional `--due-date`, when present, is a non-empty string for which `Date.parse` returns a finite timestamp.
   - Optional `--reference`, when present, is non-empty after trim.

9. For valid input, append one `payment-request.received` event using the canonical shape, then call `runRiskAssess` against that stored event. Generate `requestId` and `correlationId` with `crypto.randomUUID()`.

10. Print a concise success result containing the request event ID, verdict, Proposal ID, pending status, and authority level. Return nonzero with a useful error for invalid flags, missing `roles.risk.assess` configuration, provider failure, or invalid model output.

11. Add the command to `COMMANDS`, the “Implemented so far” help sentence, and `run()` routing. Unknown `request` subcommands must print help and return nonzero, following existing group routing. Do not change the behavior of generic `event add`.

12. Add `risk.assess` to `examples/instance.example.json`, referencing the already declared `local` provider. Do not add credentials, provider-specific secrets, or futco/private instance edits.

13. Add focused tests in `test/riskAssess.test.js` covering:

    - Assessment schema acceptance and normalization for all three verdicts, including empty `riskFactors` and empty `evidenceEventIds`.
    - Rejection of malformed JSON, extra keys, invalid verdicts, missing fields, blank risk factors, duplicate citations, and fabricated evidence IDs.
    - Deterministic vendor-history selection via `subject.id` and `payload.vendorId`, exclusion of unrelated vendors, exclusion of the request itself, newest-first bounding, and an empty-history case.
    - The full path from a stored `payment-request.received` Event through an injected role response to exactly one pending `proposal.created` Event.
    - Preservation of causation and correlation identifiers.
    - `flag-payment-request` resolving to authority level 3.
    - An `APPROVE` verdict remaining a pending Proposal with no Decision or Action event.
    - CLI help and validation for missing fields, invalid amount, invalid currency, and invalid due date, each leaving the event log empty.
    - Invalid model output leaving the request Event in place and creating no Proposal.
    - Provider and model attribution coming from configuration rather than model output.
    - `registerActionExecutor` has no `flag-payment-request` entry after the CLI module loads.

### Acceptance Criteria

- `request submit` records a normalized payment-request Event and invokes `risk.assess`.
- A valid role response creates exactly one pending `flag-payment-request` Proposal at authority level 3.
- `HOLD`, `APPROVE`, and `CHECK` all follow the same pending human-review path.
- No Decision or Action is created during submission or assessment.
- The role receives only bounded, vendor-relevant prior history and cannot cite an event it was not given.
- Invalid request input creates neither a request Event nor a Proposal.
- Invalid or ungrounded role output creates no Proposal and returns a clear error, leaving the request Event in the log.
- No action executor exists for `flag-payment-request`.
- The example instance configuration includes `risk.assess` without introducing secrets.
- `npm install && npm run check` passes.

