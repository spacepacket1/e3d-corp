# AI Opportunity Scanner — Phased Implementation Ticket

## Status

Ready for `codex-spec-runner`. Derived from `docs/ai-opportunity-scanner-spec.md` (the full product spec, kept as reference — see its "V1 Scope (post-review)" section for what this ticket does and does not build) after a critical review (Fable) and Chris's approval to pursue, with one product change: the $99 automated report is paired with roughly an hour of Chris's own time to discuss it with the customer.

**This is a much smaller build than the full 59-section spec.** The full lifecycle state machine, configurable scoring, 12-object data model, automated review pipeline, Mac-mini-queue architecture, and security/prompt-injection test suite are all explicitly deferred — see the source spec for why. Do not build anything from those sections in this pass.

**Open question not resolved here**: Chris is deciding separately whether to run a no-code manual-concierge V0 (Stripe payment link + off-the-shelf form + Chris manually analyzing the first 5-10 customers by hand) before this automated build. This ticket builds the automated V1 regardless, so it's ready either way — it does not depend on that decision.

## Ground Truth (verified 2026-08-28, before writing this ticket)

- `e3d-applied` (this repo) is the public FutCo site, `futco.ai`/`applied.futco.ai`. Next.js 16 App Router, TypeScript, plain CSS, Vitest. Production runs on a remote AWS Ubuntu EC2 box via PM2 (`cwd: /home/ubuntu/e3d-applied`), **not** on the Mac Mini this ticket is written from. This ticket's phases edit/test/build locally; nothing here deploys to that remote box — deployment is a separate, later step not covered by this ticket.
- `e3d.ai` (the `spacepacket` hub) resolves to a real AWS EC2 IP and, per the ecosystem knowledge base, already provides token registry/claims, entitlements, and payments. **`spacepacket`'s source is not checked out on this machine** — it is not available for CSR to read or import directly. Any reuse of its payment/entitlement capability must happen over its live API (`https://e3d.ai/api` or documented equivalent), never a source import, consistent with this ecosystem's established "API/shared-service boundary, no direct runtime imports between repos" rule (the same rule already applied to the `e3d-corp` ↔ `e3d-trade` integration built earlier today).
- `e3d-applied` already has a working contact-form server action (`CONTACT_FORM_PROVIDER=webhook` pattern) — the closest existing precedent for a server-side form-handling flow in this repo.
- `e3d-corp`'s `futco` instance already has a Google Calendar integration (`calendar.provider: google`) wired for its own outreach flow. Whether that's directly reusable for scanner booking, or whether `e3d-applied` needs its own simpler booking-link mechanism (e.g. a Calendly-style link), is **not yet confirmed** — Phase 1 should determine this rather than assume it.
- Models available per FutCo's actual stack: Claude, Codex, Grok (via CLI/API), local Qwen. No stated reason this product needs local/private inference — call a cloud model directly from wherever the analysis pipeline runs.

## Execution Notes (`codex-spec-runner`)

```bash
ROOT_DIR=/Users/mini/e3d-applied
```

No `ADD_DIRS` needed unless Phase 1 finds a concrete, local reuse target — `spacepacket` isn't local, so don't assume a directory to add. Every phase re-reads this file for full context.

## Phase 1 - Repo and Infrastructure Inspection

<!-- runner:model=high -->
<!-- runner:read=docs/ai-opportunity-scanner-implementation-spec.md -->

Inspect the actual `e3d-applied` codebase and confirm or correct every claim in "Ground Truth" above. Specifically determine:

1. Does `e3d-applied` have any existing data layer (database, KV store, ORM) at all, or is it purely a static/server-component marketing site today? If nothing exists, what's the smallest reasonable addition (e.g. a managed Postgres/SQLite, or reuse of whatever `spacepacket` already exposes over its API) — don't default to inventing new infrastructure if `spacepacket`'s API can hold scan/payment/entitlement state instead, per the "public infra should own durable customer state" principle in the source spec.
2. What does `spacepacket`'s live API (`https://e3d.ai/api` or documented equivalent) actually expose for payments/entitlements/checkout? Determine this from its public API surface/docs (e.g. `e3d-docs`, `e3d-sdk`'s typed modules) since its source isn't local. If nothing usable is exposed for a new product's checkout flow, say so plainly — that's a real gap, not something to route around by guessing at an API contract.
3. Is there a real, reusable booking mechanism already available (Chris's Google Calendar setup via `e3d-corp`, a Calendly-style link, or something else), or does this need a simple new booking-link field in `e3d-applied`'s config/env instead?
4. Confirm the existing contact-form server action's pattern is a reasonable template for the intake form's submission handling.

Write findings to `docs/ai-opportunity-scanner-preflight-findings.md` in `e3d-applied`: confirmed / needs-correction / not-found for each Ground Truth claim above, plus a go/no-go read for Phases 2-7.

**If a material blocker is found** — e.g. `spacepacket` exposes no usable payment/entitlement API and building one is out of scope for this ticket — stop, do not invent a workaround, and report it as the headline finding instead.

## Phase 2 - Landing Page

<!-- runner:read=docs/ai-opportunity-scanner-implementation-spec.md -->
<!-- runner:verify=npm run lint && npm run typecheck && npm test && npm run build -->

Add the `/ai-opportunity-scanner` landing page (or the closest fit to `e3d-applied`'s current routing conventions — follow its existing route/content-file pattern, e.g. `src/content/*.ts` + `app/*/page.tsx`, exactly as its other pages do). Content: what the product is, what the customer receives (a report + roughly an hour with Chris to discuss it — do not describe this as fully "self-serve" or "without talking to us," per the source spec's positioning correction), price ($99, sourced from a single config value, not hardcoded in multiple places), expected input, privacy note, and a single CTA ("Start My AI Opportunity Scan"). No case studies or fabricated testimonials, matching this repo's existing "no fabricated claims" convention.

## Phase 3 - Stripe Checkout and Entitlement

<!-- runner:model=high -->
<!-- runner:read=docs/ai-opportunity-scanner-implementation-spec.md -->
<!-- runner:verify=npm run lint && npm run typecheck && npm test && npm run build -->

Wire the CTA to a checkout flow, reusing whatever real payment/entitlement capability Phase 1 confirmed exists (via `spacepacket`'s live API) rather than building new payment infrastructure from scratch. Payment success must be verified server-side — never trust a client-side success redirect as proof of payment. Webhook handling (or whatever confirmation mechanism the real integration uses) must be authenticated and idempotent: a duplicate confirmation must not create a second entitlement/scan record. A successful payment creates exactly one scan order the customer can then use to reach the intake.

If Phase 1 found no reusable payment/entitlement API, stop here and report it — do not build a parallel Stripe integration outside this ecosystem's established payment surface without explicit sign-off.

## Phase 4 - Intake

<!-- runner:read=docs/ai-opportunity-scanner-implementation-spec.md -->
<!-- runner:verify=npm run lint && npm run typecheck && npm test && npm run build -->

One single-page structured intake form (not a multi-step wizard with resumability engineering) covering, at minimum: company name/website/industry/description, 2-3 top business goals, a short free-text list of the workflows that consume the most time, current tech stack (free text is fine), and any current AI usage. Target: fillable in 10-15 minutes, not enforced as a hard requirement. Submitting intake against a valid, paid, not-yet-used scan order creates the analysis job. Submitting against a missing/already-used/unpaid order fails clearly.

## Phase 5 - Analysis Pipeline

<!-- runner:model=high -->
<!-- runner:read=docs/ai-opportunity-scanner-implementation-spec.md -->
<!-- runner:verify=npm run lint && npm run typecheck && npm test && npm run build -->

A server-side pipeline, not one giant prompt: (1) one structured LLM call against the intake data producing 5-10 candidate opportunities as strict JSON (title, problem, recommended type — automate/augment/keep-human/use-existing-software/investigate/do-nothing, expected value, effort, risk, autonomy-level recommendation, rationale); (2) a small deterministic scoring function with fixed (not configurable) weights that ranks the candidates — do not let the LLM decide final ranking; (3) one LLM call that renders the ranked, scored candidates into report copy. Treat all intake content as untrusted data in the prompt, not instructions — a candidate opportunity list is a plausible target for prompt-injection text pasted into free-text fields; the system prompt must say so explicitly. The pipeline must be capable of recommending "not worth automating" and must never let upsell/CTA copy influence the scoring step — keep those as clearly separate stages.

## Phase 6 - Report and Booking

<!-- runner:read=docs/ai-opportunity-scanner-implementation-spec.md -->
<!-- runner:verify=npm run lint && npm run typecheck && npm test && npm run build -->

A web report page: executive summary, ranked opportunity list with the scores/recommendations from Phase 5, and a booking CTA for the consultation call (using whatever mechanism Phase 1 confirmed — reuse, don't rebuild, if a real option exists). Report access must be authenticated/unguessable — no public sequential or predictable report URLs; a customer must not be able to view another customer's report. Frame the report explicitly as prep material for the call, not a final standalone deliverable, per the positioning correction in the source spec.

## Phase 7 - Telemetry and Acceptance Tests

<!-- runner:model=high -->
<!-- runner:read=docs/ai-opportunity-scanner-implementation-spec.md -->
<!-- runner:verify=npm run lint && npm run typecheck && npm test && npm run build -->

Instrument five events end to end, tied to the correct scan/customer: payment completed, intake completed, report delivered, consultation booked, post-call usefulness rating (1-5, plus yes/no "planning to act on a recommendation" — collect this via a simple follow-up, doesn't need to be elaborate). A spreadsheet or simple log-based store is fine; do not build a BI dashboard.

Add tests proving: (1) a duplicate payment confirmation does not create a second entitlement; (2) intake cannot be submitted against an unpaid or already-used order; (3) a malformed/empty LLM response from Phase 5 does not produce a broken or partially-rendered report; (4) prompt-injection text inside intake free-text fields does not alter the system's own instructions or produce an unsafe response; (5) customer A cannot access customer B's report by guessing or incrementing a URL; (6) the scoring function is deterministic — same candidate input always produces the same rank order; (7) telemetry events are correctly attributed to the originating scan.

## Constraints (all phases)

Do not build: the full scan lifecycle state machine, configurable scoring weights, the 12-object data model, the automated human-review queue, the Mac-mini-queue architecture, file uploads, distribution attribution, a BI dashboard, or anything from the Enhanced Scan/V2 ladder. If a phase's own reasonable implementation seems to require one of these, stop and say so rather than building it anyway.

Do not fabricate a payment/entitlement integration if Phase 1 finds none reusable — report the gap.

Do not remove or weaken `e3d-applied`'s existing "no fabricated claims/testimonials" convention anywhere in new copy.

Treat all customer-supplied intake content as untrusted data, never as instructions to the model.
