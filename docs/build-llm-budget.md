# Feature Ticket: LLM Token/Cost Budget and Boss-Provider-Gated Second Opinions

## Overview

Every LLM call in `e3d-corp` today is free in the system's own accounting — `lib/evaluation/metrics.js`'s `computeCostPerUsefulOpportunity` is hardcoded toward `null` because, in its own comment, *"no LLM call in this codebase records token usage/cost yet."* That's true for every provider kind the registry supports (`local`, `openai-compatible`, `grok-cli`), and it means nothing downstream — whether a second provider's opinion is worth its cost, whether the system is close to a subscription's usage ceiling, whether cost metrics mean anything — is actually decidable today.

This ticket does two things, in order, because the second is not buildable without the first:

1. **Make cost real.** Every provider call records what it actually cost — token usage always, a reported dollar figure where the provider itself gives one — folded into an event-sourced budget ledger the same way every other piece of state in this system is: derived from history, never a second source of truth.
2. **Make elective spend a decision, not a default.** Today (`docs/build-multi-provider-roles.md`, already shipped), a role configured with multiple providers fans out to *every* configured provider on every call, concurrently, unconditionally. This ticket changes that for `opportunity.prospect`: the first provider in the role's list is the **boss provider** — the one call that always happens, the necessary cost of the system functioning at all. Every other provider in the list is **elective** — it only runs if the boss provider's own output says a second opinion is warranted, *and* deterministic code confirms the budget allows it. Neither side gets the final word alone: the boss's request is a signal, not a command — the same "AI suggests, code decides" split every other role in this system already uses, applied to the system's own resource use.

**Scope change from the operator's original framing, made during review, flagged explicitly:** boss-gating applies to `opportunity.prospect` only in this ticket, not `opportunity.communicator`. Two independent reasons surfaced during review, not just one engineer's preference: (a) `communicator` already has a real atomic safety mechanism (the duplicate-outreach guard) built on the same event lock this ticket needs for budget reservations — layering a second lock-heavy mechanism onto a role that runs rarely (once per human-approved `pursuing` opportunity, not once per cron-driven discovery topic) multiplies real concurrency-bug surface for little savings; (b) gating `communicator`'s second draft on the boss's own "I want help" self-report is philosophically closer to "asking a model to score its own output" than `prospect`'s case is — a `prospect` candidate's usefulness is at least indirectly checkable later (did it get pursued, did it produce a real outcome); a `communicator` draft's self-assessed need for a second angle has no equivalent ground truth. `communicator` keeps today's "fan out to every configured provider, always" behavior unchanged. If the operator wants `communicator` gated too, that's a real, explicit follow-up ticket, not a silent inclusion here.

This is deliberately not the self-improvement work discussed alongside it — no prompt rewriting, no fine-tuning, no automatic role changes. The operator's own framing: hold that for later, but the system should still be able to look at itself and report whether it's doing well. `evaluate report` gaining real cost data and a budget section is exactly that — as far as "looking at itself" goes here. Nothing reads that report and acts on it but a human.

## Product Goals

- Every provider call — `local`, `openai-compatible`, `grok-cli`, success or failure — is recorded as an event carrying real usage data, not an estimate. Verified directly against the real endpoints before writing this spec (sample outputs below, in Shared Constraints): the local MLX server returns a standard `usage: {prompt_tokens, completion_tokens, total_tokens}` object; `grok --output-format json` (not `plain`, which the prior ticket used) returns `usage.total_tokens` *and* a `total_cost_usd` figure straight from the CLI. No provider needs a token-count heuristic.
- A budget is an event-sourced resource like everything else in this system, and its ledger's atomicity is real, not claimed: a **reserve-then-settle** pattern (Shared Constraints) so a budget check and its corresponding spend can never both be true for more tokens than a provider's cap allows, without ever holding the shared events lock across a slow provider call.
- `opportunity.prospect`'s boss provider (list position 0) always runs — the mandatory, unmetered-by-budget baseline cost of the system doing its job at all. If the boss's own call fails outright (timeout, malformed output, anything short of a usable response), the system does not simply fail the whole invocation the way a single unlucky provider would today — it falls back through the rest of the configured provider list, in order, still without budget-gating that fallback, because a fallback substituting for the mandatory call is exactly as mandatory as the call it's replacing. This preserves the resilience property the prior ticket already shipped and explicitly valued (*"one provider failing must not silently kill the others"*) rather than regressing it.
- A boss that successfully responds and explicitly signals it wants a second opinion gets exactly one additional, budget-gated elective call — to the next provider in the list, never a cascade through the rest.
- `evaluate report` (and `/metrics`) surfaces current budget status per provider — spent, allocated, remaining, this period — and real cost/latency per role+model, computed directly from the raw events this ticket adds (not through `experience.jsonl`'s per-chain collapsing, which has its own known limitation — see Shared Constraints). A report a human reads; nothing new acts on this data by itself.
- Preserve every convention this codebase has already earned: config holds env var names, never secret values; nothing fails open on misconfiguration; no backwards-compat shims for changed shapes; real behavior verified against the real thing, not assumed.

## Non-Goals

- Do not gate `opportunity.communicator`'s fan-out in this ticket. See the Overview's scope-change note. `communicator` keeps its current "fan out to every configured provider, always" behavior; its outreach drafts still get real usage/cost recorded (Phase 1 applies to every role, not just `prospect`), so the data needed for a future gating ticket already exists — building the gate itself is deferred.
- Do not build self-improvement, prompt-versioning-as-Proposal, fine-tuning, or any mechanism where the system changes its own future behavior without a human authorizing the specific change. The operator was explicit: hold that for later. This ticket's cost/budget data is intentionally the prerequisite that unblocks it, not a first slice of it.
- Do not build standing pre-authorization for level-2 actions. Out of scope, flagged separately in the design conversation that preceded this ticket.
- Do not fabricate a dollar cost for a provider that doesn't report one, and do not gate budget on a dollar figure at all in this ticket — even for `grok-cli`, which does report `total_cost_usd`. That figure is recorded and shown in reporting, honestly, exactly as the CLI reports it — but the prior ticket already established (quoting `../e3d-pilot/docs/grok-build.md`) that list/notional prices shouldn't be applied to a subscription/OAuth session as if they were real marginal cost. Gating real behavior (whether an elective call happens) on a notional number would make that number load-bearing in a way the prior ticket's own principle argues against. **Every budget limit in this ticket is denominated in tokens, not dollars**, for every provider kind, without exception.
- Do not fix `lib/experience/assemble.js`'s pre-existing `firstOfType` collapse (it picks only the first `opportunity.created`/`proposal.created` event per chain, so a multi-provider fan-out's non-first siblings are already invisible to Experience assembly — a real, separate gap surfaced during review, predating this ticket). This ticket avoids the problem rather than fixing it, by computing cost/latency metrics directly from raw provider-call events instead of routing through `experience.costEstimate` (Shared Constraints). Redesigning Experience assembly's chain-collapsing semantics for fan-out is real, separate work for its own ticket.
- Do not change `roles.<name>.provider`'s config shape (still `string | string[]`) or which provider is the boss (always list-position 0 for `prospect`). No new config field to name a boss explicitly.
- Do not build cross-instance or cross-provider budget pooling, rollover, or reallocation. One flat period (daily, UTC boundary) per provider, reset clean each period.

## Implementation Sequencing

1. Phase 1 — Real usage/cost capture on every provider call, for every role
2. Phase 2 — Event-sourced budget ledger (reserve/settle), config, and reporting
3. Phase 3 — Boss-signaled, budget-gated elective second opinions for `opportunity.prospect`, with boss-failure fallback

## Existing Integrations to Read First

- `lib/llm/registry.js`, `lib/llm/localClient.js`, `lib/llm/openaiCompatibleClient.js`, `lib/llm/grokCliClient.js` — read before Phase 1. `resolveProvider(...).call` currently returns a bare `string`; every one of these files and every call site (`lib/roles/opportunityProspect.js`, `lib/roles/communicator.js`) needs to change in lockstep to the new `{ text, usage, costUsd }` return shape. `createLocalLlmClient` (`lib/llm/localClient.js`) is a second, still-exported function with the same bare-string signature — it must change too, or a caller using it directly instead of going through the registry silently keeps the old contract.
- `lib/roles/opportunityProspect.js` and `lib/roles/communicator.js`, specifically `resolveProviderCalls`, `recordProviderFailure`, `normalizeProviderNames`, and the `Promise.allSettled` fan-out block in each — read before Phase 1 and Phase 3. Note that `resolveProviderCalls` today resolves *every* configured provider up front, before any call happens — Phase 3 must not carry this forward for the elective provider, or a misconfigured elective provider that's never actually elected would emit spurious failure events on every boss-only run.
- `lib/opportunities/schema.js`'s `normalizeOpportunityCandidate` and `lib/roles/communicator.js`'s `normalizeOutreachDraft` — read before Phase 3. Both are field whitelists: they construct their return object from named fields only. A new field like `wantsSecondOpinion` added to the *validated* candidate/draft shape will not survive unless these functions are explicitly taught to carry it — and per Shared Constraints below, it should specifically **not** be taught to carry it, since it's a control-plane signal, not part of the permanent Opportunity/Proposal record.
- **`lib/events/store.js`'s `withEventsLockAsync`/`appendEventWithinLock`** (not `lib/store/appendOnlyLog.js` — that file only exports the lower-level `withFileLock`/`withAsyncFileLock` that `lib/events/store.js` wraps). Read the whole file before Phase 2. This is one global lock (`.events.lock`) shared by every event append in the system, with `LOCK_TIMEOUT_MS = 5000` and `LOCK_STALE_MS = 30000` (`lib/store/appendOnlyLog.js`). **Do not hold this lock across a provider call.** `grok-cli`'s default timeout alone is 900000ms — holding the lock that long would block every other event append system-wide (lead intake, discovery passes, proposal decisions) past its 5s timeout, and past 30s another process would treat the lock as abandoned and steal it, forking the hash chain the tamper-evidence work exists to prevent. Phase 2's reserve/settle design (Shared Constraints) exists specifically so the lock is only ever held for fast, in-memory-speed operations.
- `lib/decisions/decide.js` — read before Phase 2, as the *pattern* to follow for "atomic check before an irreversible commit," not as code to reuse directly. Its guard holds the lock across the actual `send-outreach` action because that action (an SES API call) is fast; an elective LLM call is not, which is exactly why this ticket needs a different (reserve/settle) shape rather than copying that one.
- `lib/evaluation/metrics.js` and **`lib/experience/assemble.js`** — read both before Phase 1. `assembleExperience` (`lib/experience/assemble.js:102`) hardcodes `costEstimate: null` with a comment saying this needs exactly the instrumentation this ticket adds — but wiring it through `assembleExperience` inherits that file's `firstOfType` collapse (Non-Goals). `computeOpportunitiesDiscovered`/`computeOutreachFunnel` in `metrics.js` already establish the pattern this ticket follows instead: read `events.jsonl` directly rather than through `experience.jsonl`, specifically to avoid undercounting/collapsing. Phase 1's cost/latency metrics follow that same established pattern, not the `experience.costEstimate` path.
- `docs/build-multi-provider-roles.md` — read in full before Phase 3, specifically its stated goal that one provider failing must not silently kill the others. Phase 3's boss-failure fallback exists to preserve that property under the new boss/elective model, not weaken it.

## Shared Constraints

### Verified provider response shapes (real calls, made while writing this spec)

Local (`FUTCO_LLM_BASE_URL`, a real MLX server):
```json
{"choices":[{"message":{"content":"OK."}}],"usage":{"completion_tokens":0,"prompt_tokens":38,"total_tokens":39}}
```

`grok -p "..." --output-format json --sandbox read-only --no-memory --no-subagents --always-approve` (real subscription session):
```json
{
  "text": "OK.",
  "usage": {
    "input_tokens": 2551, "cache_read_input_tokens": 11520,
    "cache_creation_input_tokens": 0, "output_tokens": 26,
    "reasoning_tokens": 20, "total_tokens": 14097
  },
  "total_cost_usd": 0.00187306
}
```
(`total_tokens` here includes cached/reasoning tokens per Grok's own accounting — use `usage.total_tokens` as reported, don't re-derive it from the sub-fields.)

`openai-compatible` is not yet in real use by any instance; its response shape is the standard OpenAI chat-completions `usage` object, same field names as the local example above.

### Usage and cost live on the event, not on a side channel

- `role.provider.completed` (new event type) and `role.provider.failed` (existing, gaining fields) both carry `{ role, provider, model: string | null, usage: { promptTokens, completionTokens, totalTokens } | null, costUsd: number | null }`, plus `causationId` back to the triggering event and the role's `correlationId`, exactly like every other event in this system. `model` is `null` only when a resolution failure means no provider was ever actually reached (e.g. a missing env var, an unconfigured provider name) — every other case names the model the call was attempted against. `usage` is `null` only when no response was ever returned to measure (timeout, connection failure) — a call that returned something and then failed later (e.g. invalid JSON) still had its usage recorded.
- No provider client estimates tokens by counting characters or any other heuristic — if a real response is ever missing usage, that call's `usage` is `null`, reported honestly as unmeasured, not guessed.

### Budget: reserve, then settle — never hold the lock across a call

The problem this solves: a budget check and the append recording its spend must be atomic with each other (otherwise two concurrent elective calls can both pass a check that only one of them should have), but the thing being budgeted — a provider call — can take up to 15 minutes, and the shared events lock cannot be held anywhere near that long (see "Existing Integrations to Read First" above). The fix is two short, separately-locked steps around one long, unlocked one:

1. **Reserve** (inside `withEventsLockAsync`, fast — no provider call happens here): fold `role.provider.completed`/`.failed`/`.reserved` events for the target provider within the current period; if the sum of settled spend plus *outstanding* (unsettled) reservations leaves room under the configured `tokens` limit, append a `role.provider.reserved` event (`{ role, provider, reservationId, estimatedTokens }`, a fixed conservative estimate — the largest reasonable single-call size for that provider kind, not a guess at what this specific call will use) and return the `reservationId`. If there isn't room, return "no reservation" and nothing is appended.
2. **Call**, outside any lock, only if a reservation was granted.
3. **Settle** (inside `withEventsLockAsync` again, fast): append `role.provider.completed` or `role.provider.failed` carrying the *real* usage and the same `reservationId`, so the fold in step 1 can recognize this reservation as settled (excluded from "outstanding") from then on. If the process crashes between reserve and settle, the reservation stays outstanding and continues to count against the budget until an operator notices — a stuck reservation makes the system *more* conservative, never less, which is the safe failure direction for a budget.

`computeBudgetStatus`'s fold therefore sums three things per provider/period: settled spend (`.completed`/`.failed` with real usage), plus outstanding reservations (`.reserved` events with no matching settled event yet), against the configured limit. `remaining` is `max(0, limit - (settled + outstanding))` — never negative.

### The boss provider's request is a signal; code's budget check is the gate

- `opportunity.prospect`'s response schema gains two new optional fields the boss can set in its structured JSON: `wantsSecondOpinion: boolean` and, when `true`, `secondOpinionReason: string`. These are read directly off the parsed JSON response, before/separately from `normalizeOpportunityCandidate` — they are never added to that function's field whitelist and never appear in the `candidate` object that becomes part of the permanent `opportunity.created` payload. They're a control-plane signal for this one invocation, not part of the Opportunity record.
- Deterministic code decides whether to honor a `wantsSecondOpinion: true` signal: is there a next provider configured (if `roles["opportunity.prospect"].provider` names only one, the signal is recorded for observability via a dedicated field on the `opportunity.created` event's payload, e.g. `boss.wantsSecondOpinion`, but nothing is ever attempted); does that next provider have a successful reservation (the reserve/settle sequence above). Only if both hold does the elective call happen — and only that one provider is ever resolved or called; the rest of the list is untouched.
- A boss that never sets `wantsSecondOpinion` behaves exactly like today's single-provider path, at zero elective cost.

## Phase 1 — Real Usage/Cost Capture on Every Provider Call

### Requirements

- Change `resolveProvider(instanceConfig, providerName).call` from `({ systemPrompt, userPrompt }) => Promise<string>` to `({ systemPrompt, userPrompt }) => Promise<{ text: string, usage: { promptTokens, completionTokens, totalTokens } | null, costUsd: number | null }>`. Update `lib/llm/localClient.js` (both `callLocalLlm` and the still-exported `createLocalLlmClient`) and `lib/llm/openaiCompatibleClient.js` to map each provider's real `usage` object (verified shapes above) into this return shape; `costUsd` stays `null` for both.
- Update `lib/llm/grokCliClient.js`: switch its invocation from `--output-format plain` to `--output-format json`, parse the resulting JSON (verified shape above), return `{ text: parsed.text, usage: { promptTokens: parsed.usage.input_tokens, completionTokens: parsed.usage.output_tokens, totalTokens: parsed.usage.total_tokens }, costUsd: parsed.total_cost_usd ?? null }`. A response that fails to parse as JSON (a new failure mode `--output-format plain` never had) is treated as a call failure with `usage: null`, same as any other malformed response.
- Update `lib/roles/opportunityProspect.js` and `lib/roles/communicator.js`'s call sites: `const rawText = await call(...)` becomes `const { text, usage, costUsd } = await call(...)`, with `parseCandidateJson`/`parseDraftJson` operating on `text`.
- Add `recordProviderCompletion({ dataDir, triggerEvent, provider, model, usage, costUsd })` alongside the existing `recordProviderFailure` (which gains `model`/`usage`/`costUsd` parameters per Shared Constraints). Call `recordProviderCompletion` for every successful provider call in both roles, in addition to whatever candidate/draft the call produced — usage is recorded regardless of whether the resulting JSON later fails schema validation (which still calls `recordProviderFailure`, now carrying the usage that *was* spent before validation failed).
- Add cost/latency-by-role-model computation to `lib/evaluation/metrics.js`, reading directly from `role.provider.completed`/`.failed` events (grouped by role+model, and separately by `correlationId` for a per-chain total) — following the same "read raw events, not `experience.jsonl`" pattern `computeOpportunitiesDiscovered`/`computeOutreachFunnel` already use in this file, not by wiring through `assembleExperience` (Non-Goals). `evaluate report`'s existing cost fields become real for the first time; `assembleExperience`'s `costEstimate` stays `null` as it is today — this ticket does not touch that file.

### Acceptance Criteria

- Against the real local provider, a completion's `role.provider.completed` event carries non-null `usage.totalTokens` matching what the endpoint actually reported.
- Against the real `grok-cli` provider, a completion's event carries non-null `usage` *and* non-null `costUsd`, matching what `grok --output-format json` actually returned — both already verified once, by hand, in this spec's Shared Constraints; re-verify at implementation time that the shape hasn't drifted.
- A provider call that returns syntactically invalid JSON still records `usage` on its `role.provider.failed` event; a call that times out records `usage: null`.
- `evaluate report` shows real, non-null cost/latency-by-role-model numbers after a real run against at least one instrumented provider — the ticket's central promise, now actually met by a named requirement rather than implied by Phase 1's existence.
- Every existing test from `docs/build-multi-provider-roles.md` continues to pass with fixtures updated for the new `{ text, usage, costUsd }` call return shape.

## Phase 2 — Event-Sourced Budget Ledger, Config, and Reporting

### Requirements

- Add `llm.budget` to the instance config schema (`.e3d-corp/config.schema.json`, `lib/config.js`'s `validateInstanceConfig`): `{ period: "daily", limits: { "<providerName>": { tokens: number } } }`. No `unit` field — every limit is tokens (Non-Goals). Optional at every level; a provider with no `limits` entry is unrestricted. Period boundary is UTC midnight; a call's period bucket is the UTC calendar date of its `role.provider.reserved`/`.completed`/`.failed` event's `occurredAt`.
- `lib/llm/budget.js` (new): `reserveBudget(dataDir, instanceConfig, providerName)` implements the reserve step (Shared Constraints) inside `withEventsLockAsync`, returning `{ granted: true, reservationId }` or `{ granted: false, reason }`. `settleReservation(dataDir, { reservationId, ...providerCompletionOrFailureFields })` implements the settle step. `computeBudgetStatus(dataDir, instanceConfig, providerName)` returns `{ provider, unlimited: true }` or `{ provider, limit, settled, outstanding, remaining, periodStart, periodEnd }`.
- `e3d-corp budget status --instance <name>` (new CLI command): renders `computeBudgetStatus` for every provider with a configured limit, matching the style of the prior ticket's `providers status`.
- Extend `evaluate report` / `/metrics` with a budget section (spent/allocated/remaining per provider, this period) using `computeBudgetStatus` directly — no separate computation.

### Acceptance Criteria

- Against a config with `llm.budget.limits.grok = { tokens: 1000 }` and a fixture log with 700 settled tokens for `grok` this period, `computeBudgetStatus` reports `remaining: 300`. With 1200 settled, `remaining: 0` (never negative).
- A `role.provider.reserved` event with no matching settled event counts as outstanding: a config with 1000-token limit, 0 settled, and one outstanding reservation of 500 reports `remaining: 500` — the reservation itself reduces what a second concurrent check would see as available, even before it's settled.
- Two simulated concurrent `reserveBudget` calls against a budget with room for exactly one more reservation result in exactly one `granted: true` and one `granted: false` — verified the same way the prior ticket tested concurrent proposal approvals.
- A provider with no `limits` entry always reports `unlimited: true`, and `reserveBudget` against it always grants, regardless of recorded spend.
- `budget status` and the `/metrics` budget section render the same numbers `computeBudgetStatus` returns directly.
- A UTC-midnight period boundary is respected: spend/reservations from yesterday do not count against today's `remaining`.

## Phase 3 — Boss-Signaled, Budget-Gated Elective Second Opinions for `opportunity.prospect`

### Requirements

- In `lib/roles/opportunityProspect.js`'s `runOpportunityProspect`: the first provider in `roles["opportunity.prospect"].provider` (or the sole provider, if a string) is resolved and called first, alone — not as part of the existing `Promise.allSettled` fan-out, which this phase removes for `prospect` in favor of sequential boss-then-maybe-elective. Its parsed response is checked for `wantsSecondOpinion`/`secondOpinionReason` (Shared Constraints) before being passed to `normalizeOpportunityCandidate`.
- **Boss failure fallback:** if the boss call fails outright (any reason — resolution failure, timeout, malformed JSON that fails validation), and more than one provider is configured, code attempts the next provider in the list as a direct substitute for the failed mandatory call — not gated by budget (Product Goals: a fallback substituting for the mandatory call is exactly as mandatory as the call it replaces), not requiring any `wantsSecondOpinion` signal (there is none; the boss never returned one). This fallback continues sequentially through the full remaining provider list, in order, until one succeeds or all are exhausted — preserving `docs/build-multi-provider-roles.md`'s "one provider failing must not silently kill the others" property under the new sequential model. Each attempt (success or failure) is still recorded via `recordProviderCompletion`/`recordProviderFailure`.
- **Elective second opinion:** if the boss succeeds and sets `wantsSecondOpinion: true`, and more than one provider is configured, code calls `reserveBudget` for the *next* provider in the list only. If granted: resolve and call that provider (only now — not eagerly resolved earlier), settle the reservation with its real usage, and if it produces a valid candidate, treat it exactly as the prior ticket treats every fanned-out candidate — an independent Opportunity sharing the boss's trigger `correlationId`. If not granted: append `role.provider.skipped` (`{ role, provider, reason: "budget exhausted" }`, same `causationId`/`correlationId` conventions as every other event here) and proceed with only the boss's candidate — no error, no retry, no silent no-op.
- Boss failure and elective second-opinion are mutually exclusive per invocation: a boss that fails never gets to express `wantsSecondOpinion` (it never returned), so the fallback path and the elective path never both fire for the same call.
- Only ever one additional provider is contacted beyond the boss, whether via fallback-after-failure or elective-after-request — never a cascade through the whole remaining list for the elective case (Product Goals); the fallback case is the one deliberate exception, because it exists for resilience parity with today's shipped behavior, not for gathering opinions.
- `runOpportunityEngine`/`runDiscoveryPass` need no changes beyond what the prior ticket already made them handle — this phase changes how many candidates a `prospect` call can produce and why, not the shape those candidates arrive in.

### Acceptance Criteria

- A 2-provider config where the stubbed boss succeeds with `wantsSecondOpinion: false` produces exactly one Opportunity, one `role.provider.completed` event, and zero reservations against the second provider — it's never touched.
- The same config with `wantsSecondOpinion: true` and budget available produces two Opportunities (boss's and the elective provider's), a settled reservation, both correctly `proposedBy`-attributed, both sharing the trigger's `correlationId`.
- The same config with `wantsSecondOpinion: true` and the second provider's budget already exhausted produces exactly one Opportunity, a `role.provider.skipped` event, and no reservation ever granted.
- A 2-provider config where the boss's call itself fails (stub throws/times out) and the second provider succeeds produces exactly one Opportunity — from the fallback provider — with no budget reservation ever attempted for that fallback call, and the boss's failure recorded via `role.provider.failed`.
- A 3-provider config where the boss fails and the second provider *also* fails falls through to the third, succeeding there — verifying the fallback chain isn't capped at one hop the way the elective path is.
- A 3-provider config where the boss succeeds and requests a second opinion results in at most one elective call (provider at list position 1) — provider at position 2 is never reached by a single boss request.
- `opportunity.communicator`'s existing fan-out behavior (every configured provider, always, unconditionally) is unchanged and covered by regression tests — this phase touches `opportunity.prospect` only.
