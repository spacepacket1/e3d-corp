You are the review stage of an autonomous repo-improvement pipeline.
Read the executed diff below and comment on correctness, regressions,
and scope-creep. Keep the response concise and actionable.

After your comments, end your response with exactly this block, on its
own lines, verbatim -- no markdown heading, comment, or bold syntax
around any of these lines:

---VERDICT---
status: approved
reason: <one-line reason>

Use "status: blocked" in place of "status: approved" only for a real
defect that must be fixed before this is merged -- a regression, a
correctness bug, a security issue. Not a style nit or an optional
suggestion; those belong in your comments above, not in a blocked verdict.
The line "---VERDICT---" must appear verbatim and on its own line; it is
a fixed parser marker, not a section title to be reworded or restyled.

Executed diff:

```diff
diff --git a/.codex-spec-runner/manifest.tsv b/.codex-spec-runner/manifest.tsv
index fb9e805..1d111b7 100644
--- a/.codex-spec-runner/manifest.tsv
+++ b/.codex-spec-runner/manifest.tsv
@@ -25,3 +25,9 @@
 2026-08-27T20:02:19-0700	docs/e3d-corp-e3d-trade-stack-spec.md	6	`e3d-trade` Outcome-Return Path	codex	gpt-5.4	exec	0	0
 2026-08-27T20:11:15-0700	docs/e3d-corp-e3d-trade-stack-spec.md	7	Acceptance Tests	codex	gpt-5.5	exec	0	0
 2026-08-27T20:14:07-0700	docs/e3d-corp-e3d-trade-stack-spec.md	8	Governed vs. Ungoverned Experiment Readiness Report	codex	gpt-5.4	exec	0	0
+2026-09-18T10:26:51-0700	/var/folders/vn/jrwn6x0579v_26grcpvwp_200000gn/T//e3d-pilot.impl-5802bc1f2fe4-repo-20260918102643.dhBOID/.e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918102643/spec-final.md	1	Vendor history selection and assessment validation (pure helpers)	codex	gpt-5.4	exec	0	0
+2026-09-18T10:28:31-0700	/var/folders/vn/jrwn6x0579v_26grcpvwp_200000gn/T//e3d-pilot.impl-5802bc1f2fe4-repo-20260918102643.dhBOID/.e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918102643/spec-final.md	2	Risk assessment orchestration (runRiskAssess)	codex	gpt-5.4	exec	0	0
+2026-09-18T10:30:35-0700	/var/folders/vn/jrwn6x0579v_26grcpvwp_200000gn/T//e3d-pilot.impl-5802bc1f2fe4-repo-20260918102643.dhBOID/.e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918102643/spec-final.md	3	CLI command and example config	codex	gpt-5.4	exec	0	75
+2026-09-18T10:36:15-0700	/var/folders/vn/jrwn6x0579v_26grcpvwp_200000gn/T/e3d-pilot.impl-5802bc1f2fe4-repo-20260918102643.dhBOID/.e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918102643/spec-final.md	1	Vendor history selection and assessment validation (pure helpers)	codex	gpt-5.4	exec	0	0
+2026-09-18T10:38:28-0700	/var/folders/vn/jrwn6x0579v_26grcpvwp_200000gn/T/e3d-pilot.impl-5802bc1f2fe4-repo-20260918102643.dhBOID/.e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918102643/spec-final.md	2	Risk assessment orchestration (runRiskAssess)	codex	gpt-5.4	exec	0	0
+2026-09-18T10:41:00-0700	/var/folders/vn/jrwn6x0579v_26grcpvwp_200000gn/T/e3d-pilot.impl-5802bc1f2fe4-repo-20260918102643.dhBOID/.e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918102643/spec-final.md	3	CLI command and example config	codex	gpt-5.4	exec	0	0
diff --git a/.e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918102643/spec-final.md b/.e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918102643/spec-final.md
new file mode 100644
index 0000000..320e39d
--- /dev/null
+++ b/.e3d-pilot/runs/impl-5802bc1f2fe4-repo-20260918102643/spec-final.md
@@ -0,0 +1,300 @@
+# Inbound Payment Request Risk Guard Prototype
+
+## Overview
+
+Add a minimal inbound payment-request guard to the existing event-sourced runtime. A CLI command records a consequential request, invokes a structured `risk.assess` role with relevant vendor history from the event log, and creates a pending level-3 `flag-payment-request` Proposal containing a `HOLD`, `APPROVE`, or `CHECK` recommendation.
+
+The prototype stops at Proposal creation. It does not execute payments or register an action executor.
+
+## Goals
+
+- Accept payment requests through a dedicated CLI command.
+- Preserve each request as an append-only Company Event.
+- Assess requests through the configured `risk.assess` provider.
+- Ground assessments in relevant existing event-log history.
+- Strictly validate the role’s structured verdict.
+- Create a pending Proposal whose authority level is derived from policy.
+- Exercise the complete Event-to-Proposal path in automated tests.
+
+## Non-Goals
+
+- Gmail, Drive, accounting, banking, or payment-provider integrations.
+- Payment execution or an executor for `flag-payment-request`.
+- Web UI, README, or private instance-config changes.
+- Decision, confirmation, Action, Outcome, or Experience workflow changes.
+- Automatic approval based on an `APPROVE` verdict.
+- New evidence providers, databases, or policy mechanisms.
+- Provider completion/failure events, budget reservations, or multi-provider fan-out.
+- General-purpose fraud detection or production-grade risk scoring.
+
+## Existing Files
+
+- `lib/cli.js` implements command routing, flag parsing, instance loading, and event creation.
+- `lib/events/store.js` provides append-only event storage and event queries. `readAllEventRecords(dataDir)` returns the log in file order.
+- `lib/roles/communicator.js` demonstrates configured-provider resolution, `{ text }` provider results, strict JSON role output, Proposal creation, and injectable LLM clients.
+- `lib/authority/policy.js` is the authoritative action-type-to-authority-level mapping.
+- `lib/proposals/create.js` derives authority from policy and appends `proposal.created`.
+- `lib/llm/registry.js` `resolveProvider` supplies `{ model, call }` even when tests inject `llmClient`.
+- `lib/actions/registry.js` exposes `getActionExecutor` / `listRegisteredActionTypes`.
+- `examples/instance.example.json` demonstrates role-to-provider configuration.
+- Existing Node test suites use temporary data directories, dummy `LLM_BASE_URL` / `LLM_MODEL` env vars, and injected provider clients that return `{ text }`.
+
+## Shared Constraints
+
+- Keep the implementation within 8 changed files and 900 changed lines.
+- Change only these files unless a listed requirement cannot be met otherwise: `lib/authority/policy.js`, `lib/roles/riskAssess.js`, `lib/cli.js`, `examples/instance.example.json`, `test/riskAssess.test.js`, `test/phase5.test.js`.
+- Models may return structured recommendations but must never append Decisions or execute Actions.
+- `authorityLevel` must be derived exclusively through the existing authority policy.
+- Every submitted request with a valid role response must produce exactly one pending Proposal regardless of whether the verdict is `HOLD`, `APPROVE`, or `CHECK`.
+- Treat an `APPROVE` verdict only as advisory text inside a pending Proposal.
+- Do not register an action executor for `flag-payment-request`.
+- Reject malformed CLI input before writing any event.
+- Reject malformed model output without creating a Proposal. The already-appended `payment-request.received` event stays in the log.
+- Do not invent evidence identifiers or include unrelated event history in the model prompt.
+- Preserve the existing event, Proposal, provider-registry, and instance-config conventions.
+- Do not add dependencies or modify private instance data.
+- Do not call `reserveBudget` / `settleReservation` or append `role.provider.completed` / `role.provider.failed`.
+- Provider `call` and injected `llmClient` functions receive `{ systemPrompt, userPrompt }` and must return `{ text }` (other fields optional), matching `lib/roles/communicator.js`. Never treat the return value as a bare string.
+- An injected `llmClient` still resolves `provider` and `model` through `resolveProvider` from instance config, never from model output. Tests that resolve a provider must set dummy `LLM_BASE_URL` and `LLM_MODEL` like existing role tests.
+- Do not invoke a live provider in tests. CLI tests cover help and validation only. The Event-to-Proposal success path and invalid-model-output path go through `runRiskAssess` with an injected `llmClient`.
+
+## Canonical Shapes
+
+Normalize vendor IDs by trimming surrounding whitespace and lowercasing. Store and match that normalized value. Trim vendor name, description, and optional reference without changing case. Normalize currency by trimming and uppercasing.
+
+The `payment-request.received` event MUST use:
+
+- `type`: `payment-request.received`
+- `source`: `cli`
+- `subject`: `{ type: "payment-request", id: <generated requestId> }`
+- `causationId`: `null`
+- `correlationId`: a newly generated UUID
+- `payload`:
+  - `requestId`: the same UUID as `subject.id`
+  - `vendorId`: normalized vendor ID
+  - `vendorName`: trimmed vendor name
+  - `amount`: a finite number greater than zero
+  - `currency`: three-letter uppercase code
+  - `description`: trimmed non-empty string
+  - `dueDate`: present only when the caller supplied a valid due date; store the provided string
+  - `reference`: present only when the caller supplied a non-empty reference; store the trimmed string
+
+`selectVendorHistory(events, requestEvent)` takes the full log in file order (from `readAllEventRecords`) plus the stored request event. Vendor-history matching is exact and field-based, never substring search over serialized events. An event is relevant when all of the following are true:
+
+- Its `id` differs from the request event’s `id`.
+- It predates the request event: `occurredAt` is earlier, or `occurredAt` is equal and it appears earlier in log order.
+- The request’s normalized `vendorId` equals either `normalizeVendorId(event.subject.id)` or `normalizeVendorId(event.payload.vendorId)` when that payload field is a string.
+
+Return at most the 20 newest relevant events, newest first by `occurredAt` descending, with log order (later in file is newer) as the tie-break. Same-millisecond history must still be selected. The allowed evidence ID set is the request event ID plus those selected prior event IDs.
+
+`parseAssessmentJson(rawText)` strips a wrapping markdown fence before `JSON.parse`, matching existing role JSON parsing, and rejects empty output and invalid JSON.
+
+`normalizeAssessment(parsed, allowedEvidenceIds)` then requires exactly one plain object with exactly these own keys and no extras:
+
+- `verdict`: `HOLD`, `APPROVE`, or `CHECK`
+- `reasoning`: a non-empty string
+- `riskFactors`: an array of non-empty strings; an empty array is allowed
+- `evidenceEventIds`: an array of unique IDs from the allowed evidence ID set; an empty array is allowed
+
+Trim `reasoning`, each risk factor, and each evidence ID. Reject extra keys, unsupported verdicts, missing fields, incorrect field types, blank strings, duplicate evidence IDs (including duplicates created by trimming), and IDs that were not supplied to the role.
+
+After validation, `createProposal` MUST be called with:
+
+- `type`: `flag-payment-request`
+- `causationId`: the request event ID
+- `correlationId`: the request event’s correlation ID
+- `instanceConfig`: the loaded instance config, so existing authority notification still runs
+- `proposedBy`: `{ role: "risk.assess", provider, model }` from the configured, resolved provider — never from model output
+- `payload`:
+  - `requestEventId`
+  - `request`: the normalized request payload fields listed above (omit `dueDate` / `reference` when absent)
+  - `assessment`: `{ verdict, reasoning, riskFactors, evidenceEventIds }` after trim/normalization
+
+Do not add a dedicated payload schema file. Generic Proposal payload handling is enough.
+
+## Phase 1 - Vendor history selection and assessment validation (pure helpers)
+
+<!-- runner:model=codex:gpt-5.4 -->
+<!-- pilot:touches=lib/authority/policy.js -->
+<!-- pilot:touches=lib/roles/riskAssess.js -->
+<!-- pilot:touches=test/riskAssess.test.js -->
+<!-- pilot:touches=test/phase5.test.js -->
+<!-- runner:read=README.md -->
+<!-- runner:read=lib/roles/communicator.js -->
+<!-- runner:read=lib/events/store.js -->
+<!-- runner:verify=npm install && node --check bin/e3d-corp && node --test --test-skip-pattern='real knowledge-base results|records evidence for the repo lookup|real integration returns real repos' $(find test -name '*.test.js' ! -name 'e3dTradeAcceptance.test.js') -->
+
+### Requirements
+
+1. Extend `ACTION_POLICY` in `lib/authority/policy.js` with `flag-payment-request` at `AUTHORITY_LEVELS.FINANCIAL_ACTION`. Set `ACTION_POLICY_VERSION` to `3`. Do not change existing action-type mappings.
+
+2. `test/phase5.test.js` has a pre-existing test asserting a thrown error message matches `/policy v2 requires 2/`, which becomes stale once `ACTION_POLICY_VERSION` is `3`. Update that single assertion (and any other place in that file hardcoding the old policy version number) to match `v3`. Do not change anything else in `test/phase5.test.js` or its surrounding test behavior.
+
+3. Create `lib/roles/riskAssess.js`. In this phase, implement and export only the pure helper functions: `normalizeVendorId`, `selectVendorHistory`, `parseAssessmentJson`, and `normalizeAssessment`. Do not implement `runRiskAssess` yet (Phase 2) -- leave it out of this file's exports entirely rather than stubbing it.
+
+4. `selectVendorHistory(events, requestEvent)` takes the full log in file order (from `readAllEventRecords`) plus the stored request event. Vendor-history matching is exact and field-based, never substring search over serialized events. An event is relevant when all of the following are true:
+
+   - Its `id` differs from the request event's `id`.
+   - It predates the request event: `occurredAt` is earlier, or `occurredAt` is equal and it appears earlier in log order.
+   - The request's normalized `vendorId` equals either `normalizeVendorId(event.subject.id)` or `normalizeVendorId(event.payload.vendorId)` when that payload field is a string.
+
+   Return at most the 20 newest relevant events, newest first by `occurredAt` descending, with log order (later in file is newer) as the tie-break. Same-millisecond history must still be selected. The allowed evidence ID set is the request event ID plus those selected prior event IDs.
+
+5. `parseAssessmentJson(rawText)` strips a wrapping markdown fence before `JSON.parse`, matching existing role JSON parsing, and rejects empty output and invalid JSON.
+
+6. `normalizeAssessment(parsed, allowedEvidenceIds)` requires exactly one plain object with exactly these own keys and no extras:
+
+   - `verdict`: `HOLD`, `APPROVE`, or `CHECK`
+   - `reasoning`: a non-empty string
+   - `riskFactors`: an array of non-empty strings; an empty array is allowed
+   - `evidenceEventIds`: an array of unique IDs from the allowed evidence ID set; an empty array is allowed
+
+   Trim `reasoning`, each risk factor, and each evidence ID. Reject extra keys, unsupported verdicts, missing fields, incorrect field types, blank strings, duplicate evidence IDs (including duplicates created by trimming), and IDs that were not supplied to the role.
+
+7. Normalize vendor IDs by trimming surrounding whitespace and lowercasing (`normalizeVendorId`). Store and match that normalized value.
+
+8. Add focused tests in `test/riskAssess.test.js` covering only this phase's surface, plus the `test/phase5.test.js` update from requirement 2:
+
+   - Assessment schema acceptance and normalization for all three verdicts, including empty `riskFactors` and empty `evidenceEventIds`.
+   - Rejection of malformed JSON, extra keys, invalid verdicts, missing fields, blank risk factors, duplicate citations, and fabricated evidence IDs.
+   - Deterministic vendor-history selection via `subject.id` and `payload.vendorId`, exclusion of unrelated vendors, exclusion of the request itself, newest-first bounding, same-`occurredAt` log-order predating, and an empty-history case.
+   - `flag-payment-request` resolving to authority level 3 (via the policy change in requirement 1).
+
+### Acceptance Criteria (this phase)
+
+- `lib/roles/riskAssess.js` exports working `normalizeVendorId`, `selectVendorHistory`, `parseAssessmentJson`, and `normalizeAssessment`, each independently tested.
+- `ACTION_POLICY` resolves `flag-payment-request` to authority level 3.
+- `npm install && npm run check` passes.
+
+## Phase 2 - Risk assessment orchestration (runRiskAssess)
+
+<!-- runner:model=codex:gpt-5.4 -->
+<!-- pilot:touches=lib/roles/riskAssess.js -->
+<!-- pilot:touches=test/riskAssess.test.js -->
+<!-- runner:read=README.md -->
+<!-- runner:read=lib/roles/communicator.js -->
+<!-- runner:read=lib/proposals/create.js -->
+<!-- runner:read=lib/events/store.js -->
+<!-- runner:read=lib/llm/registry.js -->
+<!-- runner:verify=npm install && node --check bin/e3d-corp && node --test --test-skip-pattern='real knowledge-base results|records evidence for the repo lookup|real integration returns real repos' $(find test -name '*.test.js' ! -name 'e3dTradeAcceptance.test.js') -->
+
+### Requirements
+
+1. In `lib/roles/riskAssess.js`, add and export `runRiskAssess({ dataDir, instanceConfig, requestEvent, llmClient })`, building on Phase 1's helpers. It loads history with `readAllEventRecords(dataDir)`, builds the prompt, invokes the provider, validates the response against the allowed evidence IDs, and creates the Proposal. It must not append the `payment-request.received` event -- that stays the caller's responsibility (Phase 3).
+
+2. This role is single-provider and creates exactly one Proposal. Read `instanceConfig.roles["risk.assess"].provider`. If the value is an array, use only the first name. Resolve that provider through the existing registry. Support an injected `llmClient` function for deterministic tests, following existing role conventions, including the `{ text }` return shape. If the role config is missing, throw a clear error before any provider call.
+
+3. Build a bounded role prompt containing:
+
+   - The submitted `payment-request.received` event.
+   - At most the 20 newest relevant prior events, selected via `selectVendorHistory`.
+   - The exact allowed evidence event IDs.
+   - Instructions that `APPROVE` is only a recommendation and cannot approve or execute anything.
+   - Instructions to use `CHECK` when evidence is insufficient or ambiguous and never invent facts or evidence IDs.
+
+4. The role must never append a Decision, invoke `decideProposal`, call `confirmAndExecute`, or register or invoke an action executor. Do not emit provider completion/failure events in this prototype.
+
+5. After validation, `createProposal` MUST be called with:
+
+   - `type`: `flag-payment-request`
+   - `causationId`: the request event ID
+   - `correlationId`: the request event's correlation ID
+   - `instanceConfig`: the loaded instance config, so existing authority notification still runs
+   - `proposedBy`: `{ role: "risk.assess", provider, model }` from the configured, resolved provider -- never from model output
+   - `payload`:
+     - `requestEventId`
+     - `request`: the normalized request payload fields (see Phase 3's canonical event shape; omit `dueDate` / `reference` when absent)
+     - `assessment`: `{ verdict, reasoning, riskFactors, evidenceEventIds }` after trim/normalization
+
+   Do not add a dedicated payload schema file. Generic Proposal payload handling is enough.
+
+6. Add focused tests in `test/riskAssess.test.js` covering only this phase's surface, using a stored `payment-request.received` event constructed directly in the test (not via the CLI, which doesn't exist until Phase 3):
+
+   - The full path from a stored `payment-request.received` Event through an injected `{ text }` role response to exactly one pending `proposal.created` Event.
+   - Preservation of causation and correlation identifiers.
+   - An `APPROVE` verdict remaining a pending Proposal with no Decision or Action event.
+   - Invalid model output leaving the request Event in place and creating no Proposal.
+   - Provider and model attribution coming from configuration rather than model output.
+   - Missing `roles.risk.assess` config throws before any provider call.
+
+### Acceptance Criteria (this phase)
+
+- `runRiskAssess` takes a stored request event to exactly one pending `flag-payment-request` Proposal at authority level 3, for all three verdicts.
+- No Decision or Action is ever created by this path.
+- The role receives only bounded, vendor-relevant prior history and cannot cite an event it was not given.
+- Invalid or ungrounded role output creates no Proposal and returns a clear error.
+- `npm install && npm run check` passes.
+
+## Phase 3 - CLI command and example config
+
+<!-- runner:model=codex:gpt-5.4 -->
+<!-- pilot:touches=lib/cli.js -->
+<!-- pilot:touches=examples/instance.example.json -->
+<!-- pilot:touches=test/riskAssess.test.js -->
+<!-- runner:read=README.md -->
+<!-- runner:read=lib/roles/riskAssess.js -->
+<!-- runner:read=lib/actions/registry.js -->
+<!-- runner:verify=npm install && node --check bin/e3d-corp && node --test --test-skip-pattern='real knowledge-base results|records evidence for the repo lookup|real integration returns real repos' $(find test -name '*.test.js' ! -name 'e3dTradeAcceptance.test.js') -->
+
+### Requirements
+
+1. Add a CLI command with this public shape:
+
+   `request submit --instance <name> --vendor-id <id> --vendor-name <name> --amount <number> --currency <code> --description <text> [--due-date <iso>] [--reference <text>]`
+
+   The handler must be async and `await runRiskAssess(...)`. `run()` must await that handler.
+
+2. Validate required flags before loading the instance or writing events:
+
+   - `--instance`, `--vendor-id`, `--vendor-name`, and `--description` are strings that are present and non-empty after trim. A boolean flag value (flag present with no following argument) is invalid.
+   - `--amount` must be a string; trim it, then parse with `Number(...)`. Reject missing values, non-strings (including `true`), blank, non-numeric, non-finite, zero, and negative values.
+   - `--currency` must be a string; normalize to uppercase and match `^[A-Z]{3}$`.
+   - Optional `--due-date`, when present, must be a non-empty string for which `Date.parse` returns a finite timestamp.
+   - Optional `--reference`, when present, must be a string that is non-empty after trim.
+
+3. For valid input, append one `payment-request.received` event using the canonical shape below, then `await runRiskAssess` against that stored event. Generate `requestId` and `correlationId` with `crypto.randomUUID()`.
+
+   The `payment-request.received` event MUST use:
+
+   - `type`: `payment-request.received`
+   - `source`: `cli`
+   - `subject`: `{ type: "payment-request", id: <generated requestId> }`
+   - `causationId`: `null`
+   - `correlationId`: a newly generated UUID
+   - `payload`:
+     - `requestId`: the same UUID as `subject.id`
+     - `vendorId`: normalized vendor ID
+     - `vendorName`: trimmed vendor name
+     - `amount`: a finite number greater than zero
+     - `currency`: three-letter uppercase code
+     - `description`: trimmed non-empty string
+     - `dueDate`: present only when the caller supplied a valid due date; store the provided string
+     - `reference`: present only when the caller supplied a non-empty reference; store the trimmed string
+
+   Trim vendor name, description, and optional reference without changing case. Normalize currency by trimming and uppercasing.
+
+4. Print a concise success result containing the request event ID, verdict, Proposal ID, pending status, and authority level. Return nonzero with a useful error for invalid flags, missing `roles.risk.assess` configuration, provider failure, or invalid model output.
+
+5. Add the command to `COMMANDS`, the "Implemented so far" help sentence, and `run()` routing. Unknown `request` subcommands, including `request` with no subcommand, must print help and return nonzero, following existing group routing. Do not change the behavior of generic `event add`.
+
+6. Add `risk.assess` to `examples/instance.example.json`, referencing the already declared `local` provider. Do not add credentials, provider-specific secrets, or futco/private instance edits.
+
+8. Add focused tests in `test/riskAssess.test.js` covering only this phase's surface, plus the `test/phase5.test.js` update from requirement 2:
+
+   - CLI help and validation for missing fields, invalid amount (including `--amount` with no value), invalid currency, and invalid due date, each leaving the event log empty. These CLI cases must not call a provider.
+   - `request submit` end-to-end against a temp instance with an injected/local provider path, producing the request Event and a pending Proposal.
+   - Unknown `request` subcommands, including bare `request`, print help and return nonzero.
+   - `getActionExecutor('flag-payment-request')` is `null` after the CLI module loads.
+
+### Acceptance Criteria (this phase, and overall)
+
+- `request submit` records a normalized payment-request Event and invokes `risk.assess`.
+- A valid role response creates exactly one pending `flag-payment-request` Proposal at authority level 3.
+- `HOLD`, `APPROVE`, and `CHECK` all follow the same pending human-review path.
+- No Decision or Action is created during submission or assessment.
+- The role receives only bounded, vendor-relevant prior history and cannot cite an event it was not given.
+- Invalid request input creates neither a request Event nor a Proposal.
+- Invalid or ungrounded role output creates no Proposal and returns a clear error, leaving the request Event in the log.
+- No action executor exists for `flag-payment-request`.
+- The example instance configuration includes `risk.assess` without introducing secrets.
+- `npm install && npm run check` passes.
diff --git a/examples/instance.example.json b/examples/instance.example.json
index ee84191..733da99 100644
--- a/examples/instance.example.json
+++ b/examples/instance.example.json
@@ -25,6 +25,9 @@
     },
     "opportunity.communicator": {
       "provider": "local"
+    },
+    "risk.assess": {
+      "provider": "local"
     }
   },
   "outreach": {
diff --git a/lib/authority/policy.js b/lib/authority/policy.js
index eb05484..4cdd765 100644
--- a/lib/authority/policy.js
+++ b/lib/authority/policy.js
@@ -18,7 +18,7 @@ export const AUTHORITY_LEVEL_DESCRIPTIONS = Object.freeze({
   4: 'irreversible/high-value action - mark a deal closed-won/closed-lost, public announcement; approval only, execution requires confirmAndExecute'
 });
 
-export const ACTION_POLICY_VERSION = 2;
+export const ACTION_POLICY_VERSION = 3;
 
 // Versioned policy table: action `type` -> minimum required authority level.
 // Every action-execution function (Phase 7 onward) must call
@@ -32,6 +32,7 @@ export const ACTION_POLICY = Object.freeze({
   'pilot-handoff': AUTHORITY_LEVELS.EXTERNAL_ACTION,
   capital_mandate: AUTHORITY_LEVELS.FINANCIAL_ACTION,
   'issue-invoice': AUTHORITY_LEVELS.FINANCIAL_ACTION,
+  'flag-payment-request': AUTHORITY_LEVELS.FINANCIAL_ACTION,
   'mark-deal-closed': AUTHORITY_LEVELS.IRREVERSIBLE_ACTION
 });
 
diff --git a/lib/cli.js b/lib/cli.js
index 55bb52c..c96f5d7 100644
--- a/lib/cli.js
+++ b/lib/cli.js
@@ -24,6 +24,7 @@ import { publishAnchor, verifyAgainstAnchors, verifyExternalAnchor } from './anc
 import { createEmailAnchorTransport } from './anchor/emailTransport.js';
 import { computeBudgetStatus, listBudgetProviders } from './llm/budget.js';
 import { listProviderStatuses } from './llm/registry.js';
+import { normalizeVendorId, runRiskAssess } from './roles/riskAssess.js';
 
 // The one place a real action-execution function is wired up to the type it
 // fires for - every CLI invocation and the web server both import this
@@ -40,6 +41,10 @@ const COMMANDS = [
   ['event log --instance <name> [--correlation <id>] [--since <date>]', 'Render a human-readable, ordered event log'],
   ['event verify --instance <name> [--head <hash> --count <n>]', 'Verify the hash chain, published anchors, and optionally an emailed anchor'],
   ['anchor publish --instance <name>', 'Publish the current chain head to an external anchor (email)'],
+  [
+    'request submit --instance <name> --vendor-id <id> --vendor-name <name> --amount <number> --currency <code> --description <text> [--due-date <iso>] [--reference <text>]',
+    'Record one inbound payment request and create a pending level-3 risk proposal'
+  ],
   ['run --instance <name>', 'Run the scheduled discovery pass (instance config researchTopics) through opportunity.prospect'],
   ['pursue --instance <name>', 'Run opportunity.communicator over "pursuing" opportunities that have no send-outreach proposal yet'],
   ['opportunities list --instance <name> [--status <status>] [--min-score <n>] [--pursuable-only]', 'List opportunities, pursuable first, then ranked by score (dev/debug CLI)'],
@@ -73,7 +78,7 @@ export function formatHelp() {
   lines.push(
     '',
     'Implemented so far: `config validate`, `providers status`, `event add`, `event log`, `event verify`, `anchor publish`, `run`, `pursue`, `opportunities list`, ' +
-      '`opportunities show`, `opportunities decide`, `opportunities propose-handoff`, `opportunities check-shipped`, ' +
+      '`request submit`, `opportunities show`, `opportunities decide`, `opportunities propose-handoff`, `opportunities check-shipped`, ' +
       '`proposals list`, `proposals show`, `proposals approve`, `proposals reject`, `proposals confirm`, `web`, `outcomes record`, ' +
       '`experience show`, `evaluate report`, `budget status`. The remaining commands are documented stubs for later phases.'
   );
@@ -129,6 +134,95 @@ function formatCounterpartySummary(counterparty) {
   return parts.join(', ');
 }
 
+function requireTrimmedStringFlag(flags, key, label) {
+  const value = flags[key];
+  if (typeof value !== 'string') {
+    throw new Error(`request submit requires ${label}`);
+  }
+  const trimmed = value.trim();
+  if (trimmed === '') {
+    throw new Error(`request submit requires ${label}`);
+  }
+  return trimmed;
+}
+
+function validateAmountFlag(flags) {
+  const raw = flags.amount;
+  if (typeof raw !== 'string') {
+    throw new Error('request submit requires --amount <number>');
+  }
+  const trimmed = raw.trim();
+  const amount = Number(trimmed);
+  if (trimmed === '' || !Number.isFinite(amount) || amount <= 0) {
+    throw new Error('request submit requires --amount <number> as a positive number');
+  }
+  return amount;
+}
+
+function validateCurrencyFlag(flags) {
+  const raw = flags.currency;
+  if (typeof raw !== 'string') {
+    throw new Error('request submit requires --currency <code>');
+  }
+  const normalized = raw.trim().toUpperCase();
+  if (!/^[A-Z]{3}$/.test(normalized)) {
+    throw new Error('request submit requires --currency <code> as a 3-letter ISO code');
+  }
+  return normalized;
+}
+
+function validateOptionalDueDateFlag(flags) {
+  if (!Object.hasOwn(flags, 'due-date')) {
+    return undefined;
+  }
+  const dueDate = flags['due-date'];
+  if (typeof dueDate !== 'string' || dueDate.trim() === '' || !Number.isFinite(Date.parse(dueDate))) {
+    throw new Error('request submit requires --due-date <iso> to be a valid date string');
+  }
+  return dueDate;
+}
+
+function validateOptionalReferenceFlag(flags) {
+  if (!Object.hasOwn(flags, 'reference')) {
+    return undefined;
+  }
+  const reference = flags.reference;
+  if (typeof reference !== 'string') {
+    throw new Error('request submit requires --reference <text> to be a non-empty string');
+  }
+  const trimmed = reference.trim();
+  if (trimmed === '') {
+    throw new Error('request submit requires --reference <text> to be a non-empty string');
+  }
+  return trimmed;
+}
+
+function validateRequestSubmitFlags(flags) {
+  const instanceName = requireTrimmedStringFlag(flags, 'instance', '--instance <name>');
+  const vendorId = normalizeVendorId(requireTrimmedStringFlag(flags, 'vendor-id', '--vendor-id <id>'));
+  const vendorName = requireTrimmedStringFlag(flags, 'vendor-name', '--vendor-name <name>');
+  const description = requireTrimmedStringFlag(flags, 'description', '--description <text>');
+  const amount = validateAmountFlag(flags);
+  const currency = validateCurrencyFlag(flags);
+  const dueDate = validateOptionalDueDateFlag(flags);
+  const reference = validateOptionalReferenceFlag(flags);
+
+  return {
+    instanceName,
+    payload: {
+      requestId: crypto.randomUUID(),
+      vendorId,
+      vendorName,
+      amount,
+      currency,
+      description,
+      ...(dueDate === undefined ? {} : { dueDate }),
+      ...(reference === undefined ? {} : { reference })
+    },
+    correlationId: crypto.randomUUID()
+  };
+}
+
 function eventAddCommand(args) {
   if (args.includes('--help') || args.includes('-h')) {
     printHelp();
@@ -174,6 +268,38 @@ function eventAddCommand(args) {
   return 0;
 }
 
+async function requestSubmitCommand(args) {
+  if (args.includes('--help') || args.includes('-h')) {
+    printHelp();
+    return 0;
+  }
+
+  const flags = parseFlags(args);
+  const { instanceName, payload, correlationId } = validateRequestSubmitFlags(flags);
+  const { config, dataDir } = loadInstance(instanceName);
+
+  const requestId = payload.requestId;
+  const requestEvent = appendEvent(dataDir, {
+    type: 'payment-request.received',
+    source: 'cli',
+    subject: { type: 'payment-request', id: requestId },
+    payload,
+    causationId: null,
+    correlationId
+  });
+
+  const result = await runRiskAssess({
+    dataDir,
+    instanceConfig: config,
+    requestEvent
+  });
+
+  process.stdout.write(
+    `Submitted request ${requestEvent.id}: verdict=${result.assessment.verdict}, proposal=${result.proposal.id}, status=${result.proposal.status}, authorityLevel=${result.proposal.authorityLevel}\n`
+  );
+  return 0;
+}
+
 // A hash chain nobody checks is decoration. This is the check: it exits
 // non-zero on a broken chain so a scheduled run can alert on it, and names
 // the first bad record rather than just reporting a boolean.
@@ -1051,6 +1177,16 @@ export async function run(argv = process.argv.slice(2)) {
       return 1;
     }
 
+    if (group === 'request' && subcommand === 'submit') {
+      return await requestSubmitCommand(rest);
+    }
+
+    if (group === 'request') {
+      printHelp();
+      process.stderr.write(`Unknown request command: ${subcommand ?? ''}\n`);
+      return 1;
+    }
+
     if (group === 'event') {
       printHelp();
       process.stderr.write(`Unknown event command: ${subcommand ?? ''}\n`);
diff --git a/lib/roles/riskAssess.js b/lib/roles/riskAssess.js
new file mode 100644
index 0000000..4bf1e7b
--- /dev/null
+++ b/lib/roles/riskAssess.js
@@ -0,0 +1,348 @@
+import { readAllEventRecords } from '../events/store.js';
+import { resolveProvider } from '../llm/registry.js';
+import { createProposal } from '../proposals/create.js';
+
+const ROLE_NAME = 'risk.assess';
+const ASSESSMENT_KEYS = ['verdict', 'reasoning', 'riskFactors', 'evidenceEventIds'];
+const VALID_VERDICTS = new Set(['HOLD', 'APPROVE', 'CHECK']);
+const REQUEST_EVENT_TYPE = 'payment-request.received';
+
+function stripMarkdownFence(rawText) {
+  const trimmed = rawText.trim();
+  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
+  return fenced ? fenced[1].trim() : trimmed;
+}
+
+function isPlainObject(value) {
+  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
+}
+
+function toOccurredAtTime(event) {
+  return new Date(event?.occurredAt).getTime();
+}
+
+function normalizeAllowedEvidenceIds(allowedEvidenceIds) {
+  if (!(allowedEvidenceIds instanceof Set) && !Array.isArray(allowedEvidenceIds)) {
+    throw new Error(`${ROLE_NAME} requires allowedEvidenceIds to be an array or Set`);
+  }
+
+  const normalized = new Set();
+  for (const value of allowedEvidenceIds) {
+    if (typeof value !== 'string') {
+      throw new Error(`${ROLE_NAME} allowedEvidenceIds must contain only strings`);
+    }
+    const trimmed = value.trim();
+    if (trimmed === '') {
+      throw new Error(`${ROLE_NAME} allowedEvidenceIds must not contain blank ids`);
+    }
+    normalized.add(trimmed);
+  }
+  return normalized;
+}
+
+function isNonEmptyString(value) {
+  return typeof value === 'string' && value.trim() !== '';
+}
+
+function buildSystemPrompt(companyName) {
+  return [
+    `You are the ${ROLE_NAME} role inside e3d-corp for ${companyName}.`,
+    'You assess one inbound payment request using only the event evidence supplied to you.',
+    'You can recommend HOLD, APPROVE, or CHECK, but you cannot approve, reject, confirm, execute, or mutate anything.',
+    'APPROVE is only a recommendation for a human reviewer inside a pending proposal.',
+    'Use CHECK when the evidence is insufficient, missing, ambiguous, or contradictory.',
+    'Never invent facts, never infer evidence you were not given, and never cite an evidenceEventId that is not in the allowed list.',
+    'Respond with ONLY a single JSON object matching exactly this shape:',
+    '{"verdict":"HOLD"|"APPROVE"|"CHECK","reasoning":string,"riskFactors":string[],"evidenceEventIds":string[]}',
+    'Return no prose and no markdown code fences.'
+  ].join('\n');
+}
+
+function summarizePromptEvent(event) {
+  return {
+    id: event.id,
+    type: event.type,
+    occurredAt: event.occurredAt,
+    source: event.source,
+    subject: event.subject,
+    payload: event.payload,
+    causationId: event.causationId ?? null,
+    correlationId: event.correlationId
+  };
+}
+
+function normalizeProviderName(providerConfig) {
+  if (isNonEmptyString(providerConfig)) {
+    return providerConfig.trim();
+  }
+
+  if (Array.isArray(providerConfig)) {
+    const [first] = providerConfig;
+    if (isNonEmptyString(first)) {
+      return first.trim();
+    }
+  }
+
+  throw new Error(`Instance config is missing roles.${ROLE_NAME}.provider`);
+}
+
+function normalizeRequestPayload(requestEvent) {
+  if (!requestEvent || typeof requestEvent !== 'object') {
+    throw new Error(`${ROLE_NAME} requires requestEvent`);
+  }
+  if (!isNonEmptyString(requestEvent.id)) {
+    throw new Error(`${ROLE_NAME} requires requestEvent.id`);
+  }
+  if (requestEvent.type !== REQUEST_EVENT_TYPE) {
+    throw new Error(`${ROLE_NAME} requires requestEvent.type to be "${REQUEST_EVENT_TYPE}"`);
+  }
+  if (!isNonEmptyString(requestEvent.correlationId)) {
+    throw new Error(`${ROLE_NAME} requires requestEvent.correlationId`);
+  }
+
+  const request = requestEvent.payload;
+  if (!isPlainObject(request)) {
+    throw new Error(`${ROLE_NAME} requires requestEvent.payload to be an object`);
+  }
+
+  if (!isNonEmptyString(request.requestId)) {
+    throw new Error(`${ROLE_NAME} requires requestEvent.payload.requestId`);
+  }
+  const vendorId = normalizeVendorId(request.vendorId);
+  if (!vendorId) {
+    throw new Error(`${ROLE_NAME} requires requestEvent.payload.vendorId to be a non-empty string`);
+  }
+  if (!isNonEmptyString(request.vendorName)) {
+    throw new Error(`${ROLE_NAME} requires requestEvent.payload.vendorName to be a non-empty string`);
+  }
+  if (typeof request.amount !== 'number' || !Number.isFinite(request.amount) || request.amount <= 0) {
+    throw new Error(`${ROLE_NAME} requires requestEvent.payload.amount to be a finite number greater than zero`);
+  }
+  if (!isNonEmptyString(request.currency)) {
+    throw new Error(`${ROLE_NAME} requires requestEvent.payload.currency to be a non-empty string`);
+  }
+  if (!isNonEmptyString(request.description)) {
+    throw new Error(`${ROLE_NAME} requires requestEvent.payload.description to be a non-empty string`);
+  }
+
+  const normalized = {
+    requestId: request.requestId.trim(),
+    vendorId,
+    vendorName: request.vendorName.trim(),
+    amount: request.amount,
+    currency: request.currency.trim().toUpperCase(),
+    description: request.description.trim()
+  };
+
+  if (request.dueDate !== undefined) {
+    if (!isNonEmptyString(request.dueDate)) {
+      throw new Error(`${ROLE_NAME} requires requestEvent.payload.dueDate to be a non-empty string when present`);
+    }
+    normalized.dueDate = request.dueDate;
+  }
+
+  if (request.reference !== undefined) {
+    if (!isNonEmptyString(request.reference)) {
+      throw new Error(`${ROLE_NAME} requires requestEvent.payload.reference to be a non-empty string when present`);
+    }
+    normalized.reference = request.reference.trim();
+  }
+
+  return normalized;
+}
+
+function buildPrompt({ requestEvent, priorEvents, allowedEvidenceEventIds, instanceConfig }) {
+  return {
+    systemPrompt: buildSystemPrompt(instanceConfig?.name || 'the company'),
+    userPrompt: JSON.stringify(
+      {
+        requestEvent: summarizePromptEvent(requestEvent),
+        priorVendorEvents: priorEvents.map(summarizePromptEvent),
+        allowedEvidenceEventIds
+      },
+      null,
+      2
+    )
+  };
+}
+
+export function normalizeVendorId(vendorId) {
+  return typeof vendorId === 'string' ? vendorId.trim().toLowerCase() : null;
+}
+
+export function selectVendorHistory(events, requestEvent) {
+  if (!Array.isArray(events)) {
+    throw new Error(`${ROLE_NAME} selectVendorHistory requires events to be an array`);
+  }
+  if (!requestEvent || typeof requestEvent !== 'object') {
+    throw new Error(`${ROLE_NAME} selectVendorHistory requires requestEvent`);
+  }
+
+  const requestVendorId = normalizeVendorId(requestEvent.payload?.vendorId);
+  if (!requestVendorId) {
+    throw new Error(`${ROLE_NAME} requestEvent.payload.vendorId must be a non-empty string`);
+  }
+
+  const requestIndex = events.findIndex((event) => event?.id === requestEvent.id);
+  if (requestIndex === -1) {
+    throw new Error(`${ROLE_NAME} selectVendorHistory requires requestEvent to be present in events`);
+  }
+
+  const requestTime = toOccurredAtTime(requestEvent);
+  const matches = [];
+
+  events.forEach((event, index) => {
+    if (!event || typeof event !== 'object') return;
+    if (event.id === requestEvent.id) return;
+
+    const eventTime = toOccurredAtTime(event);
+    const predatesRequest = eventTime < requestTime || (eventTime === requestTime && index < requestIndex);
+    if (!predatesRequest) return;
+
+    const subjectVendorId = normalizeVendorId(event.subject?.id);
+    const payloadVendorId = typeof event.payload?.vendorId === 'string' ? normalizeVendorId(event.payload.vendorId) : null;
+    if (subjectVendorId !== requestVendorId && payloadVendorId !== requestVendorId) return;
+
+    matches.push({ event, index, eventTime });
+  });
+
+  matches.sort((left, right) => {
+    if (left.eventTime !== right.eventTime) {
+      return right.eventTime - left.eventTime;
+    }
+    return right.index - left.index;
+  });
+
+  return matches.slice(0, 20).map(({ event }) => event);
+}
+
+export function parseAssessmentJson(rawText) {
+  if (typeof rawText !== 'string' || rawText.trim() === '') {
+    throw new Error(`${ROLE_NAME} returned empty output`);
+  }
+
+  const stripped = stripMarkdownFence(rawText);
+  if (stripped === '') {
+    throw new Error(`${ROLE_NAME} returned empty output`);
+  }
+
+  try {
+    return JSON.parse(stripped);
+  } catch (error) {
+    throw new Error(`${ROLE_NAME} returned invalid JSON: ${error.message}`);
+  }
+}
+
+export function normalizeAssessment(parsed, allowedEvidenceIds) {
+  if (!isPlainObject(parsed)) {
+    throw new Error(`${ROLE_NAME} assessment must be a plain object`);
+  }
+
+  const keys = Object.keys(parsed);
+  const missingKeys = ASSESSMENT_KEYS.filter((key) => !Object.hasOwn(parsed, key));
+  const extraKeys = keys.filter((key) => !ASSESSMENT_KEYS.includes(key));
+  if (missingKeys.length > 0 || extraKeys.length > 0 || keys.length !== ASSESSMENT_KEYS.length) {
+    throw new Error(
+      `${ROLE_NAME} assessment must contain exactly these keys: ${ASSESSMENT_KEYS.join(', ')}`
+    );
+  }
+
+  if (!VALID_VERDICTS.has(parsed.verdict)) {
+    throw new Error(`${ROLE_NAME} assessment verdict must be one of HOLD, APPROVE, CHECK`);
+  }
+
+  if (typeof parsed.reasoning !== 'string' || parsed.reasoning.trim() === '') {
+    throw new Error(`${ROLE_NAME} assessment reasoning must be a non-empty string`);
+  }
+  const reasoning = parsed.reasoning.trim();
+
+  if (!Array.isArray(parsed.riskFactors)) {
+    throw new Error(`${ROLE_NAME} assessment riskFactors must be an array of non-empty strings`);
+  }
+  const riskFactors = parsed.riskFactors.map((factor) => {
+    if (typeof factor !== 'string') {
+      throw new Error(`${ROLE_NAME} assessment riskFactors must be an array of non-empty strings`);
+    }
+    const trimmed = factor.trim();
+    if (trimmed === '') {
+      throw new Error(`${ROLE_NAME} assessment riskFactors must not contain blank strings`);
+    }
+    return trimmed;
+  });
+
+  if (!Array.isArray(parsed.evidenceEventIds)) {
+    throw new Error(`${ROLE_NAME} assessment evidenceEventIds must be an array`);
+  }
+
+  const allowedSet = normalizeAllowedEvidenceIds(allowedEvidenceIds);
+  const seenEvidenceIds = new Set();
+  const evidenceEventIds = parsed.evidenceEventIds.map((id) => {
+    if (typeof id !== 'string') {
+      throw new Error(`${ROLE_NAME} assessment evidenceEventIds must contain only strings`);
+    }
+    const trimmed = id.trim();
+    if (trimmed === '') {
+      throw new Error(`${ROLE_NAME} assessment evidenceEventIds must not contain blank ids`);
+    }
+    if (seenEvidenceIds.has(trimmed)) {
+      throw new Error(`${ROLE_NAME} assessment evidenceEventIds must not contain duplicates`);
+    }
+    if (!allowedSet.has(trimmed)) {
+      throw new Error(`${ROLE_NAME} assessment evidenceEventIds must only cite supplied event ids`);
+    }
+    seenEvidenceIds.add(trimmed);
+    return trimmed;
+  });
+
+  return {
+    verdict: parsed.verdict,
+    reasoning,
+    riskFactors,
+    evidenceEventIds
+  };
+}
+
+export async function runRiskAssess({ dataDir, instanceConfig, requestEvent, llmClient } = {}) {
+  if (!dataDir) {
+    throw new Error('runRiskAssess requires a dataDir');
+  }
+
+  const provider = normalizeProviderName(instanceConfig?.roles?.[ROLE_NAME]?.provider);
+  const { model, call } = resolveProvider(instanceConfig, provider);
+
+  if (llmClient !== undefined && typeof llmClient !== 'function') {
+    throw new Error('runRiskAssess requires llmClient to be a function when provided');
+  }
+
+  const normalizedRequest = normalizeRequestPayload(requestEvent);
+  const events = readAllEventRecords(dataDir);
+  const priorEvents = selectVendorHistory(events, requestEvent);
+  const allowedEvidenceEventIds = [requestEvent.id, ...priorEvents.map((event) => event.id)];
+  const { systemPrompt, userPrompt } = buildPrompt({
+    requestEvent,
+    priorEvents,
+    allowedEvidenceEventIds,
+    instanceConfig
+  });
+
+  const response = await (llmClient ?? call)({ systemPrompt, userPrompt });
+  const assessment = normalizeAssessment(parseAssessmentJson(response?.text), allowedEvidenceEventIds);
+  const created = createProposal(dataDir, {
+    type: 'flag-payment-request',
+    payload: {
+      requestEventId: requestEvent.id,
+      request: normalizedRequest,
+      assessment
+    },
+    proposedBy: { role: ROLE_NAME, provider, model },
+    causationId: requestEvent.id,
+    correlationId: requestEvent.correlationId,
+    instanceConfig
+  });
+
+  return {
+    assessment,
+    proposal: created.proposal,
+    event: created.event
+  };
+}
diff --git a/test/phase5.test.js b/test/phase5.test.js
index 183887a..bc64c44 100644
--- a/test/phase5.test.js
+++ b/test/phase5.test.js
@@ -120,7 +120,7 @@ test('assertProposalAuthorized refuses a pending proposal and passes an approved
     assert.throws(() => assertProposalAuthorized(proposal, 'issue-invoice'), /expected "issue-invoice"/);
     assert.throws(
       () => assertProposalAuthorized({ ...proposal, status: 'approved', authorityLevel: 3 }, 'send-outreach'),
-      /policy v2 requires 2/
+      /policy v3 requires 2/
     );
 
     const approved = { ...proposal, status: 'approved' };
diff --git a/test/riskAssess.test.js b/test/riskAssess.test.js
new file mode 100644
index 0000000..55f60f0
--- /dev/null
+++ b/test/riskAssess.test.js
@@ -0,0 +1,802 @@
+import assert from 'node:assert/strict';
+import { execFileSync } from 'node:child_process';
+import fs from 'node:fs';
+import os from 'node:os';
+import path from 'node:path';
+import test from 'node:test';
+import { fileURLToPath } from 'node:url';
+import { appendEvent, queryEvents, readAllEventRecords } from '../lib/events/store.js';
+import { listExecutedActions } from '../lib/actions/log.js';
+import { getActionExecutor } from '../lib/actions/registry.js';
+import { run } from '../lib/cli.js';
+import { runRiskAssess } from '../lib/roles/riskAssess.js';
+
+const ORIGINAL_ENV = {
+  RISK_LLM_BASE_URL: process.env.RISK_LLM_BASE_URL,
+  RISK_LLM_MODEL: process.env.RISK_LLM_MODEL,
+  RISK_LLM_MODEL_ALPHA: process.env.RISK_LLM_MODEL_ALPHA,
+  RISK_LLM_MODEL_BETA: process.env.RISK_LLM_MODEL_BETA
+};
+
+process.env.RISK_LLM_BASE_URL = process.env.RISK_LLM_BASE_URL ?? 'http://127.0.0.1:9999';
+process.env.RISK_LLM_MODEL = process.env.RISK_LLM_MODEL ?? 'risk-model-local';
+process.env.RISK_LLM_MODEL_ALPHA = process.env.RISK_LLM_MODEL_ALPHA ?? 'risk-model-alpha';
+process.env.RISK_LLM_MODEL_BETA = process.env.RISK_LLM_MODEL_BETA ?? 'risk-model-beta';
+
+const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
+const BIN = path.join(ROOT, 'bin', 'e3d-corp');
+
+test.after(() => {
+  for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
+    if (value === undefined) {
+      delete process.env[name];
+      continue;
+    }
+    process.env[name] = value;
+  }
+});
+
+function makeTempDataDir() {
+  return fs.mkdtempSync(path.join(os.tmpdir(), 'e3d-corp-risk-assess-'));
+}
+
+function runCli(args, options = {}) {
+  const { env, ...rest } = options;
+  return execFileSync(process.execPath, [BIN, ...args], {
+    cwd: ROOT,
+    encoding: 'utf8',
+    stdio: ['ignore', 'pipe', 'pipe'],
+    env: { ...process.env, ...env },
+    ...rest
+  });
+}
+
+function makeTempInstance(extra = {}) {
+  const name = `risk-cli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
+  const instanceDir = path.join(ROOT, '.e3d-corp', 'instance', name);
+  const dataDir = `.e3d-corp/instance/${name}`;
+  fs.mkdirSync(instanceDir, { recursive: true });
+  fs.writeFileSync(
+    path.join(instanceDir, 'instance.json'),
+    JSON.stringify(
+      {
+        name,
+        dataDir,
+        llm: {
+          providers: {
+            local: {
+              kind: 'local',
+              baseUrlEnvVar: 'RISK_CLI_TEST_BASE_URL',
+              modelEnvVar: 'RISK_CLI_TEST_MODEL'
+            }
+          }
+        },
+        research: {
+          webSearchProvider: 'disabled'
+        },
+        eventSources: [],
+        roles: {
+          'risk.assess': {
+            provider: 'local'
+          }
+        },
+        ...extra
+      },
+      null,
+      2
+    )
+  );
+
+  return {
+    name,
+    instanceDir,
+    dataDir: path.join(ROOT, dataDir)
+  };
+}
+
+function cleanupTempInstance(instance) {
+  fs.rmSync(instance.instanceDir, { recursive: true, force: true });
+}
+
+function readStoredEvents(dataDir) {
+  const eventLogPath = path.join(dataDir, 'events.jsonl');
+  if (!fs.existsSync(eventLogPath)) {
+    return [];
+  }
+  return readAllEventRecords(dataDir);
+}
+
+async function captureRun(args, { env = {}, fetchImpl } = {}) {
+  const stdout = [];
+  const stderr = [];
+  const previousExitCode = process.exitCode;
+  const previousFetch = globalThis.fetch;
+  const previousEnv = new Map();
+  const originalStdoutWrite = process.stdout.write;
+  const originalStderrWrite = process.stderr.write;
+
+  process.stdout.write = ((chunk, encoding, callback) => {
+    stdout.push(String(chunk));
+    if (typeof encoding === 'function') {
+      encoding();
+    } else if (typeof callback === 'function') {
+      callback();
+    }
+    return true;
+  });
+  process.stderr.write = ((chunk, encoding, callback) => {
+    stderr.push(String(chunk));
+    if (typeof encoding === 'function') {
+      encoding();
+    } else if (typeof callback === 'function') {
+      callback();
+    }
+    return true;
+  });
+
+  for (const [key, value] of Object.entries(env)) {
+    previousEnv.set(key, process.env[key]);
+    if (value === undefined) {
+      delete process.env[key];
+    } else {
+      process.env[key] = value;
+    }
+  }
+
+  if (fetchImpl !== undefined) {
+    globalThis.fetch = fetchImpl;
+  }
+
+  process.exitCode = undefined;
+
+  try {
+    const code = await run(args);
+    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
+  } finally {
+    process.stdout.write = originalStdoutWrite;
+    process.stderr.write = originalStderrWrite;
+    process.exitCode = previousExitCode;
+    if (fetchImpl !== undefined) {
+      globalThis.fetch = previousFetch;
+    }
+    for (const [key, value] of previousEnv.entries()) {
+      if (value === undefined) {
+        delete process.env[key];
+      } else {
+        process.env[key] = value;
+      }
+    }
+  }
+}
+
+function baseInstanceConfig(overrides = {}) {
+  return {
+    name: 'ExampleCo',
+    llm: {
+      providers: {
+        local: {
+          kind: 'local',
+          baseUrlEnvVar: 'RISK_LLM_BASE_URL',
+          modelEnvVar: 'RISK_LLM_MODEL'
+        }
+      }
+    },
+    roles: {
+      'risk.assess': {
+        provider: 'local'
+      }
+    },
+    ...overrides
+  };
+}
+
+function appendHistoryEvent(
+  dataDir,
+  { id, occurredAt, subject = { type: 'vendor', id: 'vendor-42' }, payload = {}, correlationId = `history-${id}` }
+) {
+  return appendEvent(dataDir, {
+    type: 'invoice.recorded',
+    source: 'test',
+    subject,
+    payload,
+    causationId: null,
+    correlationId,
+    occurredAt
+  });
+}
+
+function appendRequestEvent(dataDir, overrides = {}) {
+  const requestId = overrides.requestId ?? 'request-1';
+  const correlationId = overrides.correlationId ?? 'risk-corr-1';
+  return appendEvent(dataDir, {
+    type: 'payment-request.received',
+    source: 'cli',
+    subject: { type: 'payment-request', id: requestId },
+    payload: {
+      requestId,
+      vendorId: ' vendor-42 ',
+      vendorName: '  Vendor Forty Two  ',
+      amount: 2500,
+      currency: ' usd ',
+      description: '  September invoice  ',
+      ...(overrides.payload ?? {})
+    },
+    causationId: null,
+    correlationId,
+    occurredAt: overrides.occurredAt ?? '2026-09-18T10:30:00.000Z'
+  });
+}
+
+function llmResponse(text) {
+  return { text };
+}
+
+test('runRiskAssess builds a bounded vendor-history prompt and creates one pending flag-payment-request proposal', async () => {
+  const dataDir = makeTempDataDir();
+
+  try {
+    const relevantIds = [];
+    for (let index = 0; index < 22; index += 1) {
+      const id = `history-${String(index).padStart(2, '0')}`;
+      relevantIds.push(
+        appendHistoryEvent(dataDir, {
+          id,
+          occurredAt: `2026-09-18T09:${String(index).padStart(2, '0')}:00.000Z`,
+          payload: { vendorId: 'vendor-42', note: `history ${index}` }
+        }).id
+      );
+    }
+
+    appendHistoryEvent(dataDir, {
+      id: 'unrelated-history',
+      occurredAt: '2026-09-18T09:59:00.000Z',
+      subject: { type: 'vendor', id: 'vendor-other' },
+      payload: { vendorId: 'vendor-other' }
+    });
+
+    const requestEvent = appendRequestEvent(dataDir);
+
+    appendHistoryEvent(dataDir, {
+      id: 'future-history',
+      occurredAt: '2026-09-18T10:31:00.000Z',
+      payload: { vendorId: 'vendor-42' }
+    });
+
+    let capturedPrompt = null;
+    const result = await runRiskAssess({
+      instanceConfig: baseInstanceConfig(),
+      dataDir,
+      requestEvent,
+      llmClient: async ({ systemPrompt, userPrompt }) => {
+        const parsedUserPrompt = JSON.parse(userPrompt);
+        capturedPrompt = {
+          systemPrompt,
+          userPrompt: parsedUserPrompt
+        };
+        return llmResponse(
+          JSON.stringify({
+            verdict: 'HOLD',
+            reasoning: '  Hold until vendor callback confirms details.  ',
+            riskFactors: ['  bank details changed  '],
+            evidenceEventIds: [requestEvent.id, parsedUserPrompt.allowedEvidenceEventIds[1]]
+          })
+        );
+      }
+    });
+
+    assert.ok(capturedPrompt);
+    assert.match(capturedPrompt.systemPrompt, /APPROVE is only a recommendation/i);
+    assert.match(capturedPrompt.systemPrompt, /Use CHECK when the evidence is insufficient/i);
+    assert.match(capturedPrompt.systemPrompt, /ambiguous/i);
+    assert.equal(capturedPrompt.userPrompt.requestEvent.id, requestEvent.id);
+    assert.equal(capturedPrompt.userPrompt.priorVendorEvents.length, 20);
+    assert.deepEqual(
+      capturedPrompt.userPrompt.priorVendorEvents.map((event) => event.id),
+      relevantIds.slice(-20).reverse()
+    );
+    assert.ok(!capturedPrompt.userPrompt.priorVendorEvents.some((event) => event.id === 'unrelated-history'));
+    assert.ok(!capturedPrompt.userPrompt.priorVendorEvents.some((event) => event.id === 'future-history'));
+    assert.deepEqual(capturedPrompt.userPrompt.allowedEvidenceEventIds, [requestEvent.id, ...relevantIds.slice(-20).reverse()]);
+
+    assert.equal(result.proposal.type, 'flag-payment-request');
+    assert.equal(result.proposal.authorityLevel, 3);
+    assert.equal(result.proposal.status, 'pending');
+    assert.equal(result.proposal.causationId, requestEvent.id);
+    assert.equal(result.proposal.correlationId, requestEvent.correlationId);
+    assert.deepEqual(result.proposal.proposedBy, {
+      role: 'risk.assess',
+      provider: 'local',
+      model: 'risk-model-local'
+    });
+    assert.deepEqual(result.proposal.payload.request, {
+      requestId: 'request-1',
+      vendorId: 'vendor-42',
+      vendorName: 'Vendor Forty Two',
+      amount: 2500,
+      currency: 'USD',
+      description: 'September invoice'
+    });
+    assert.deepEqual(result.proposal.payload.assessment, {
+      verdict: 'HOLD',
+      reasoning: 'Hold until vendor callback confirms details.',
+      riskFactors: ['bank details changed'],
+      evidenceEventIds: [requestEvent.id, capturedPrompt.userPrompt.allowedEvidenceEventIds[1]]
+    });
+    assert.equal(result.event.type, 'proposal.created');
+    assert.equal(result.event.causationId, requestEvent.id);
+    assert.equal(result.event.correlationId, requestEvent.correlationId);
+
+    assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 1);
+    assert.equal(queryEvents(dataDir, { type: 'proposal.approved' }).length, 0);
+    assert.equal(queryEvents(dataDir, { type: 'proposal.rejected' }).length, 0);
+    assert.equal(queryEvents(dataDir, { type: 'role.provider.completed' }).length, 0);
+    assert.equal(queryEvents(dataDir, { type: 'role.provider.failed' }).length, 0);
+    assert.deepEqual(listExecutedActions(dataDir), []);
+  } finally {
+    fs.rmSync(dataDir, { recursive: true, force: true });
+  }
+});
+
+test('runRiskAssess creates a pending level-3 proposal for HOLD, CHECK, and APPROVE without decisions or actions', async () => {
+  for (const verdict of ['HOLD', 'CHECK', 'APPROVE']) {
+    const dataDir = makeTempDataDir();
+    try {
+      const requestEvent = appendRequestEvent(dataDir, {
+        requestId: `request-${verdict.toLowerCase()}`,
+        correlationId: `corr-${verdict.toLowerCase()}`
+      });
+
+      const result = await runRiskAssess({
+        instanceConfig: baseInstanceConfig(),
+        dataDir,
+        requestEvent,
+        llmClient: async () =>
+          llmResponse(
+            JSON.stringify({
+              verdict,
+              reasoning: ` ${verdict} reasoning `,
+              riskFactors: [],
+              evidenceEventIds: []
+            })
+          )
+      });
+
+      assert.equal(result.proposal.status, 'pending');
+      assert.equal(result.proposal.authorityLevel, 3);
+      assert.equal(result.proposal.payload.assessment.verdict, verdict);
+      assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 1);
+      assert.equal(queryEvents(dataDir, { type: 'proposal.approved' }).length, 0);
+      assert.equal(queryEvents(dataDir, { type: 'proposal.rejected' }).length, 0);
+      assert.deepEqual(listExecutedActions(dataDir), []);
+    } finally {
+      fs.rmSync(dataDir, { recursive: true, force: true });
+    }
+  }
+});
+
+test('invalid or ungrounded model output leaves the request event in place and creates no proposal', async () => {
+  const dataDir = makeTempDataDir();
+
+  try {
+    appendHistoryEvent(dataDir, {
+      id: 'history-evidence',
+      occurredAt: '2026-09-18T09:15:00.000Z',
+      payload: { vendorId: 'vendor-42' }
+    });
+    const requestEvent = appendRequestEvent(dataDir, {
+      requestId: 'request-invalid',
+      correlationId: 'corr-invalid'
+    });
+
+    await assert.rejects(
+      runRiskAssess({
+        instanceConfig: baseInstanceConfig(),
+        dataDir,
+        requestEvent,
+        llmClient: async () =>
+          llmResponse(
+            JSON.stringify({
+              verdict: 'CHECK',
+              reasoning: 'Need more validation.',
+              riskFactors: ['unverified bank change'],
+              evidenceEventIds: ['fabricated-evidence-id']
+            })
+          )
+      }),
+      /evidenceEventIds must only cite supplied event ids/
+    );
+
+    const records = readAllEventRecords(dataDir);
+    assert.equal(records.filter((event) => event.type === 'payment-request.received').length, 1);
+    assert.equal(records.filter((event) => event.type === 'proposal.created').length, 0);
+    assert.equal(records.at(-1).id, requestEvent.id);
+  } finally {
+    fs.rmSync(dataDir, { recursive: true, force: true });
+  }
+});
+
+test('provider and model attribution come from the configured first provider, not model output', async () => {
+  const dataDir = makeTempDataDir();
+
+  try {
+    const requestEvent = appendRequestEvent(dataDir, {
+      requestId: 'request-provider-array',
+      correlationId: 'corr-provider-array'
+    });
+    let calls = 0;
+
+    const result = await runRiskAssess({
+      instanceConfig: baseInstanceConfig({
+        llm: {
+          providers: {
+            alpha: {
+              kind: 'local',
+              baseUrlEnvVar: 'RISK_LLM_BASE_URL',
+              modelEnvVar: 'RISK_LLM_MODEL_ALPHA'
+            },
+            beta: {
+              kind: 'local',
+              baseUrlEnvVar: 'RISK_LLM_BASE_URL',
+              modelEnvVar: 'RISK_LLM_MODEL_BETA'
+            }
+          }
+        },
+        roles: {
+          'risk.assess': {
+            provider: ['alpha', 'beta']
+          }
+        }
+      }),
+      dataDir,
+      requestEvent,
+      llmClient: async () => {
+        calls += 1;
+        return {
+          text: JSON.stringify({
+            verdict: 'CHECK',
+            reasoning: 'The model might mention beta, but config still wins.',
+            riskFactors: [],
+            evidenceEventIds: []
+          }),
+          model: 'invented-model-output'
+        };
+      }
+    });
+
+    assert.equal(calls, 1);
+    assert.deepEqual(result.proposal.proposedBy, {
+      role: 'risk.assess',
+      provider: 'alpha',
+      model: 'risk-model-alpha'
+    });
+  } finally {
+    fs.rmSync(dataDir, { recursive: true, force: true });
+  }
+});
+
+test('missing roles.risk.assess config throws before any provider call', async () => {
+  const dataDir = makeTempDataDir();
+
+  try {
+    const requestEvent = appendRequestEvent(dataDir, {
+      requestId: 'request-missing-config',
+      correlationId: 'corr-missing-config'
+    });
+    let calls = 0;
+
+    await assert.rejects(
+      runRiskAssess({
+        instanceConfig: {
+          name: 'ExampleCo',
+          llm: {
+            providers: {
+              local: {
+                kind: 'local',
+                baseUrlEnvVar: 'RISK_LLM_BASE_URL',
+                modelEnvVar: 'RISK_LLM_MODEL'
+              }
+            }
+          },
+          roles: {}
+        },
+        dataDir,
+        requestEvent,
+        llmClient: async () => {
+          calls += 1;
+          return llmResponse('{}');
+        }
+      }),
+      /missing roles\.risk\.assess\.provider/
+    );
+
+    assert.equal(calls, 0);
+    assert.equal(queryEvents(dataDir, { type: 'proposal.created' }).length, 0);
+  } finally {
+    fs.rmSync(dataDir, { recursive: true, force: true });
+  }
+});
+
+test('request submit help shows the public command shape', () => {
+  const output = runCli(['request', 'submit', '--help']);
+  assert.match(
+    output,
+    /request submit --instance <name> --vendor-id <id> --vendor-name <name> --amount <number> --currency <code> --description <text>/
+  );
+});
+
+test('request submit rejects invalid flags before writing events or calling a provider', { concurrency: false }, async () => {
+  const instance = makeTempInstance();
+  let fetchCalls = 0;
+  const env = {
+    RISK_CLI_TEST_BASE_URL: 'http://risk-cli-test.invalid',
+    RISK_CLI_TEST_MODEL: 'risk-cli-model'
+  };
+
+  const cases = [
+    {
+      args: [
+        'request',
+        'submit',
+        '--instance',
+        instance.name,
+        '--vendor-id',
+        'vendor-42',
+        '--amount',
+        '2500',
+        '--currency',
+        'USD',
+        '--description',
+        'September invoice'
+      ],
+      error: /request submit requires --vendor-name <name>/
+    },
+    {
+      args: [
+        'request',
+        'submit',
+        '--instance',
+        instance.name,
+        '--vendor-id',
+        'vendor-42',
+        '--vendor-name',
+        'Vendor Forty Two',
+        '--amount',
+        '--currency',
+        'USD',
+        '--description',
+        'September invoice'
+      ],
+      error: /request submit requires --amount <number>/
+    },
+    {
+      args: [
+        'request',
+        'submit',
+        '--instance',
+        instance.name,
+        '--vendor-id',
+        'vendor-42',
+        '--vendor-name',
+        'Vendor Forty Two',
+        '--amount',
+        'not-a-number',
+        '--currency',
+        'USD',
+        '--description',
+        'September invoice'
+      ],
+      error: /request submit requires --amount <number> as a positive number/
+    },
+    {
+      args: [
+        'request',
+        'submit',
+        '--instance',
+        instance.name,
+        '--vendor-id',
+        'vendor-42',
+        '--vendor-name',
+        'Vendor Forty Two',
+        '--amount',
+        '2500',
+        '--currency',
+        'US',
+        '--description',
+        'September invoice'
+      ],
+      error: /request submit requires --currency <code> as a 3-letter ISO code/
+    },
+    {
+      args: [
+        'request',
+        'submit',
+        '--instance',
+        instance.name,
+        '--vendor-id',
+        'vendor-42',
+        '--vendor-name',
+        'Vendor Forty Two',
+        '--amount',
+        '2500',
+        '--currency',
+        'USD',
+        '--description',
+        'September invoice',
+        '--due-date',
+        'not-a-date'
+      ],
+      error: /request submit requires --due-date <iso> to be a valid date string/
+    }
+  ];
+
+  try {
+    for (const testCase of cases) {
+      const result = await captureRun(testCase.args, {
+        env,
+        fetchImpl: async () => {
+          fetchCalls += 1;
+          throw new Error('fetch should not be called for invalid request submit input');
+        }
+      });
+      assert.equal(result.code, 1);
+      assert.match(result.stderr, testCase.error);
+      assert.equal(fetchCalls, 0);
+      assert.deepEqual(readStoredEvents(instance.dataDir), []);
+    }
+  } finally {
+    cleanupTempInstance(instance);
+  }
+});
+
+test('request submit records a normalized request event and one pending proposal end to end', { concurrency: false }, async () => {
+  const instance = makeTempInstance();
+  const requests = [];
+
+  try {
+    const result = await captureRun(
+      [
+        'request',
+        'submit',
+        '--instance',
+        instance.name,
+        '--vendor-id',
+        ' Vendor-42 ',
+        '--vendor-name',
+        '  Vendor Forty Two  ',
+        '--amount',
+        ' 2500.5 ',
+        '--currency',
+        ' usd ',
+        '--description',
+        '  September invoice  ',
+        '--due-date',
+        '2026-10-31',
+        '--reference',
+        '  INV-42  '
+      ],
+      {
+        env: {
+          RISK_CLI_TEST_BASE_URL: 'http://risk-cli-test.invalid',
+          RISK_CLI_TEST_MODEL: 'risk-cli-model'
+        },
+        fetchImpl: async (url, options = {}) => {
+          const body = JSON.parse(options.body);
+          requests.push({ url, body });
+          const userPrompt = JSON.parse(body.messages[1].content);
+          const requestEventId = userPrompt.requestEvent.id;
+          return {
+            ok: true,
+            async json() {
+              return {
+                choices: [
+                  {
+                    message: {
+                      content: JSON.stringify({
+                        verdict: 'CHECK',
+                        reasoning: '  Need a human to verify the new banking details.  ',
+                        riskFactors: ['  new banking details  '],
+                        evidenceEventIds: [` ${requestEventId} `]
+                      })
+                    }
+                  }
+                ],
+                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
+              };
+            }
+          };
+        }
+      }
+    );
+
+    assert.equal(result.code, 0);
+    assert.match(
+      result.stdout,
+      /Submitted request [0-9a-f-]+: verdict=CHECK, proposal=[0-9a-f-]+, status=pending, authorityLevel=3/
+    );
+    assert.equal(result.stderr, '');
+    assert.equal(requests.length, 1);
+    assert.equal(requests[0].url, 'http://risk-cli-test.invalid/chat/completions');
+    assert.equal(requests[0].body.model, 'risk-cli-model');
+
+    const events = readStoredEvents(instance.dataDir);
+    const requestEvents = events.filter((event) => event.type === 'payment-request.received');
+    const proposalEvents = events.filter((event) => event.type === 'proposal.created');
+
+    assert.equal(requestEvents.length, 1);
+    assert.equal(proposalEvents.length, 1);
+    assert.equal(events.filter((event) => event.type === 'proposal.approved').length, 0);
+    assert.equal(events.filter((event) => event.type === 'proposal.rejected').length, 0);
+    assert.equal(events.filter((event) => event.type === 'action.executed').length, 0);
+    assert.equal(events.filter((event) => event.type === 'decision.recorded').length, 0);
+    assert.deepEqual(listExecutedActions(instance.dataDir), []);
+
+    const [requestEvent] = requestEvents;
+    assert.equal(requestEvent.source, 'cli');
+    assert.equal(requestEvent.subject.type, 'payment-request');
+    assert.equal(requestEvent.subject.id, requestEvent.payload.requestId);
+    assert.equal(requestEvent.causationId, null);
+    assert.deepEqual(requestEvent.payload, {
+      requestId: requestEvent.subject.id,
+      vendorId: 'vendor-42',
+      vendorName: 'Vendor Forty Two',
+      amount: 2500.5,
+      currency: 'USD',
+      description: 'September invoice',
+      dueDate: '2026-10-31',
+      reference: 'INV-42'
+    });
+
+    const [proposalEvent] = proposalEvents;
+    assert.equal(proposalEvent.payload.type, 'flag-payment-request');
+    assert.equal(proposalEvent.payload.status, 'pending');
+    assert.equal(proposalEvent.payload.authorityLevel, 3);
+    assert.equal(proposalEvent.causationId, requestEvent.id);
+    assert.equal(proposalEvent.correlationId, requestEvent.correlationId);
+    assert.deepEqual(proposalEvent.payload.proposedBy, {
+      role: 'risk.assess',
+      provider: 'local',
+      model: 'risk-cli-model'
+    });
+    assert.deepEqual(proposalEvent.payload.payload.request, {
+      requestId: requestEvent.subject.id,
+      vendorId: 'vendor-42',
+      vendorName: 'Vendor Forty Two',
+      amount: 2500.5,
+      currency: 'USD',
+      description: 'September invoice',
+      dueDate: '2026-10-31',
+      reference: 'INV-42'
+    });
+    assert.deepEqual(proposalEvent.payload.payload.assessment, {
+      verdict: 'CHECK',
+      reasoning: 'Need a human to verify the new banking details.',
+      riskFactors: ['new banking details'],
+      evidenceEventIds: [requestEvent.id]
+    });
+  } finally {
+    cleanupTempInstance(instance);
+  }
+});
+
+test('unknown request subcommands, including bare request, print help and return nonzero', () => {
+  const cases = [
+    { args: ['request'], error: /Unknown request command:/ },
+    { args: ['request', 'unknown'], error: /Unknown request command: unknown/ }
+  ];
+
+  for (const testCase of cases) {
+    assert.throws(
+      () => runCli(testCase.args),
+      (error) => {
+        assert.match(error.stderr.toString(), testCase.error);
+        assert.match(error.stdout.toString(), /Usage:/);
+        assert.match(error.stdout.toString(), /request submit --instance <name>/);
+        return true;
+      }
+    );
+  }
+});
+
+test('cli module does not register a flag-payment-request action executor', () => {
+  assert.equal(getActionExecutor('flag-payment-request'), null);
+});

```
