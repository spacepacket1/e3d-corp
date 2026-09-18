```spec
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
- Web UI changes.
- Decision, confirmation, Action, Outcome, or Experience workflow changes.
- Automatic approval based on an `APPROVE` verdict.
- New evidence providers, databases, or policy mechanisms.
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
- Models may return structured recommendations but must never append Decisions or execute Actions.
- `authorityLevel` must be derived exclusively through the existing authority policy.
- Every submitted request must produce a pending Proposal regardless of whether the verdict is `HOLD`, `APPROVE`, or `CHECK`.
- Treat an `APPROVE` verdict only as advisory text inside a pending Proposal.
- Do not register an action executor for `flag-payment-request`.
- Reject malformed CLI input and malformed model output without creating a Proposal.
- Do not invent evidence identifiers or include unrelated event history in the model prompt.
- Preserve the existing event, Proposal, provider-registry, and instance-config conventions.
- Do not add dependencies or modify private instance data.

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

1. Extend `ACTION_POLICY` in `lib/authority/policy.js` with `flag-payment-request` at `AUTHORITY_LEVELS.FINANCIAL_ACTION`. Increment the policy version consistently with the repository’s versioning convention.

2. Add `lib/roles/riskAssess.js` implementing the `risk.assess` role.

3. Define and export strict assessment parsing, validation, and normalization helpers. The accepted model response must be exactly one JSON object with:

   - `verdict`: one of `HOLD`, `APPROVE`, or `CHECK`.
   - `reasoning`: a non-empty string.
   - `riskFactors`: an array of non-empty strings.
   - `evidenceEventIds`: an array of unique event IDs.

   Reject empty output, invalid JSON, extra unsupported verdict values, missing fields, incorrect field types, blank strings, duplicate evidence IDs, and evidence IDs that were not supplied to the role.

4. Build a bounded role prompt containing:

   - The submitted `payment-request.received` event.
   - At most the 20 newest relevant prior events.
   - The exact allowed evidence event IDs.
   - Instructions that `APPROVE` is only a recommendation and cannot approve or execute anything.
   - Instructions to use `CHECK` when evidence is insufficient or ambiguous and never invent facts or evidence IDs.

5. Select prior vendor history deterministically from the event store. A relevant event must predate and differ from the request event and match the request’s normalized vendor identifier through either its subject or an explicit vendor identifier in its payload. Do not use arbitrary substring matching over serialized event contents.

6. Resolve the provider from `roles["risk.assess"].provider` through the existing provider registry. Support an injected LLM client for deterministic tests, following existing role conventions. Attribute the Proposal with `{ role: "risk.assess", provider, model }` from the configured and resolved provider rather than model output.

7. After successful validation, create exactly one Proposal through `createProposal` with:

   - Type `flag-payment-request`.
   - The request event as its causal origin.
   - The request’s existing correlation ID.
   - A payload containing the request event ID, normalized request details, normalized assessment, and cited evidence IDs.
   - Pending status and authority level 3 as derived by existing Proposal and policy code.

8. The role must never append a Decision, invoke `decideProposal`, call `confirmAndExecute`, or register or invoke an action executor.

9. Add a CLI command with this public shape:

   `request submit --instance <name> --vendor-id <id> --vendor-name <name> --amount <number> --currency <code> --description <text> [--due-date <iso>] [--reference <text>]`

10. The command must validate required flags before writing:

    - Vendor ID, vendor name, and description are non-empty.
    - Amount is finite and greater than zero.
    - Currency is normalized to uppercase and consists of exactly three ASCII letters.
    - Optional due date, when present, is a valid ISO timestamp.
    - Optional reference, when present, is non-empty.

11. For valid input, append one `payment-request.received` event with a generated request ID and correlation ID, `source: "cli"`, a stable payment-request subject, and a normalized payload containing the vendor and request fields. Then run `risk.assess` against that event.

12. Print a concise success result containing the request event ID, verdict, Proposal ID, pending status, and authority level. Return nonzero with a useful error for invalid flags, missing `roles.risk.assess` configuration, provider failure, or invalid model output.

13. Add the command to CLI help and routing without changing the behavior of generic `event add`.

14. Add `risk.assess` to `examples/instance.example.json`, referencing an already declared example provider. Do not add credentials or provider-specific secrets.

15. Add focused tests in `test/riskAssess.test.js` covering:

    - Assessment schema acceptance and normalization for all three verdicts.
    - Rejection of malformed JSON, invalid verdicts, missing fields, blank risk factors, duplicate citations, and fabricated evidence IDs.
    - Deterministic vendor-history selection, exclusion of unrelated vendors, exclusion of the request itself, newest-first bounding, and an empty-history case.
    - The full path from a stored `payment-request.received` Event through an injected role response to one pending `proposal.created` Event.
    - Preservation of causation and correlation identifiers.
    - `flag-payment-request` resolving to authority level 3.
    - An `APPROVE` verdict remaining a pending Proposal with no Decision or Action event.
    - CLI help and validation for missing fields, invalid amount, invalid currency, and invalid due date.
    - Provider and model attribution coming from configuration rather than model output.

### Acceptance Criteria

- `request submit` records a normalized payment-request Event and invokes `risk.assess`.
- A valid role response creates exactly one pending `flag-payment-request` Proposal at authority level 3.
- `HOLD`, `APPROVE`, and `CHECK` all follow the same pending human-review path.
- No Decision or Action is created during submission or assessment.
- The role receives only bounded, vendor-relevant prior history and cannot cite an event it was not given.
- Invalid request input creates neither a request Event nor a Proposal.
- Invalid or ungrounded role output creates no Proposal and returns a clear error.
- No action executor exists for `flag-payment-request`.
- The example instance configuration includes `risk.assess` without introducing secrets.
- `npm install && npm run check` passes.
```

---DRAFT-STATUS---
status: ok
reason: The prototype fits in one phase touching five unprotected files and remains within the 20-file/700-line limits.
