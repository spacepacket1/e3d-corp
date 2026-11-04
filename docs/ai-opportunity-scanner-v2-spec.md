# AI Opportunity Scanner — Source-Grounded Product & Implementation Specification (V2)

## Status

**Proposed.** This supersedes the framing (not the underlying product idea) of the earlier `docs/ai-opportunity-scanner-spec.md` in this repo — that document converged on a manual-concierge-only approach after finding no reusable card-checkout API. Not implemented. Spec only, per explicit instruction.

**Correction (2026-08-29, same day this was written): the "no Stripe exists anywhere" finding below was wrong**, and it was load-bearing for §25/§48's original recommendation. The error had two real causes, not fabrication: (1) `spacepacket`'s local checkout is at `/Users/mini/e3d` — a directory that was visible in this session's very first `ls` output and was never checked, because every search targeted the name `spacepacket` (its GitHub repo name) instead of the literal local directory sitting there; (2) for repos that *do* call Stripe indirectly (`e3d-netdoctor`), the client code deliberately never references "Stripe" by name — it only calls the backend — so a text search for the literal string correctly found nothing, and "no string match" was wrongly read as "no integration" instead of "the integration is abstracted behind the backend, as designed." §2 and §25 below are corrected in place; the rest of the document (analysis pipeline, report quality, distribution/trust risk) is unaffected by this correction and stands as originally written.

---

## 1. Executive Summary

One finding here is as load-bearing as "`discover` doesn't read source code" was for the Codebase Scan review — but it cuts the other way, toward *more* of the automated V1 being cheaply buildable, not less:

1. **FutCo already has a real, production, product-agnostic Stripe payment platform — in `spacepacket` (local checkout: `/Users/mini/e3d`), not in any of the customer-facing repos.** `server/productPaymentsService.js` (~1,100 lines) is a genuine product-agnostic credit/entitlement ledger; `server/productRegistry.js` registers each product (`cast`, `maps`, `netdoctor`) with a config block, including a `stripe: { enabled, packs }` block that's an explicit, working extension point — add a config block, get Stripe Checkout, webhook fulfillment, and receipt emails for free. `server/stripePayments.js` handles Checkout session creation and webhook fulfillment against real, live routes (`/api/payments/stripe/packs`, `/api/payments/credits/{quote,purchase,balance,spend}`). There's also a separate, real, per-user Stripe *subscription* system (`server/subscriptionPayments.js`, committed the same day this spec was written) — a materially different, deliberately separate flow (recurring "premium" plans vs. one-time product credit packs) worth knowing exists but not the one this product needs. **Card payment for a new product is very likely a config-registration task against existing infrastructure, not new payment engineering.**
2. **§56's premise — that a live `/products` page currently marks this product "COMING SOON" — is still false**, independent of the Stripe correction above. `https://applied.futco.ai/products` returns a live **404**. No such page, route, or content file exists anywhere, locally or in production.

Bottom line, revised: the single biggest assumed cost in the earlier version of this review — building new payment infrastructure from scratch — was wrong. The genuinely new engineering left is narrower: the analysis pipeline (candidate generation, scoring, report synthesis) and the customer-facing durable state in `e3d-applied` (or wherever the checkout UI lives). That doesn't automatically mean "skip the manual V0" — the report-quality and distribution/trust risks below are untouched by this correction — but it does mean the automated V1's payment layer is no longer a reason to delay it. See the revised §25 and §48.

---

## 2. Source-of-Truth Findings

### `e3d-applied` / futco.ai

Confirmed (re-verified today, consistent with the earlier review): Next.js 16 App Router, TypeScript, content in `src/content/*.ts`, deployed via PM2 to a remote AWS Ubuntu EC2 box (`cwd: /home/ubuntu/e3d-applied`), not the Mac Mini. Current routes: `/`, `/about`, `/contact`, `/how-we-work`, `/methodology`, `/portfolio`, `/privacy`, `/services`, `/terms`. **No `/products` route exists.** No durable data layer (no DB client, ORM, KV SDK) anywhere in the app. A real, working contact-form server action (`app/contact/actions.ts`) with validation, origin-checking, honeypot/rate-limiting, and a provider-adapter delivery pattern (`src/lib/contact-delivery.ts`, `CONTACT_FORM_PROVIDER=webhook`) — the best existing template for new form-handling work in this repo. `NEXT_PUBLIC_BOOKING_URL` config field already exists but is unset ("still needed before launch" per the repo's own README).

### Commerce / payments

Corrected finding (§1): `spacepacket`'s local checkout at `/Users/mini/e3d` has a real, mature, product-agnostic payment platform in `server/`:

- `productRegistry.js` — per-product config; each registered product (`cast`, `maps`, `netdoctor`) gets a `stripe: { enabled, packs }` block plus a credit-pack catalog. This is the actual, working "add a product = add a config block" extension point.
- `productPaymentsService.js` (~1,100 lines) — the product-agnostic ledger: `grantCredits`/`spendCredits`/`getKeyMetadata`, plus crypto-transfer verification for wallet payment methods.
- `stripePayments.js` — Checkout session creation and webhook fulfillment (canonical webhook at `/payments/stripe/webhook`), merges repeat top-ups into one running balance.
- `productPaymentsRoutes.js` — the real HTTP surface: `/api/payments/products`, `/api/payments/credits/{quote,purchase,balance,spend,session}`, `/api/payments/stripe/packs`, plus a shared `/pay` page with a card option.
- `stripeReceiptMailer.js` — receipt/credit-key-recovery emails, already built.
- A **separate**, deliberately independent per-user Stripe *subscription* system (`subscriptionPayments.js`, `subscriptionRoutes.js`) for recurring "premium" plans — not the flow this product needs (one-time report purchases, not a subscription), but worth knowing it exists so the two aren't conflated.

**Registering the AI Opportunity Scanner as a new product (a `productRegistry.js` config block, a price/credit-pack entry, a Stripe product/price on Stripe's side) is real work, but it's configuration against existing, tested infrastructure — not building checkout, webhook handling, or fulfillment from scratch.** That work happens in `spacepacket`, a separate repo from wherever this product's own customer-facing UI/intake/report lives — a real cross-repo dependency to plan for (see §41), not something this product's own implementation phases can complete unilaterally, but a config change, not new payment engineering.

### Agent/model execution

Confirmed, consistent with earlier findings: a local Qwen model runs on the Mac Mini (used by `e3d-trade`), reachable at `127.0.0.1:5050`. No queue, job-claim, or poll/consume pattern exists anywhere in the ecosystem — searched explicitly (`job.*claim`, `claimJob`, `jobQueue`, `pollQueue`) across `e3d-applied`, `e3d-corp`, `e3d-maps`, `e3d-trade`; zero hits. The "AWS creates job, Mac mini claims it" pattern in §10 of this brief is aspirational, not derived from an existing pattern — it would be built from scratch if used at all.

### `e3d-corp`

Already directly exercised twice today for real: it's a company-agnostic Event→Opportunity→Proposal→Decision→Action→Outcome→Experience runtime with human-gated actions and a hash-chained event log. Correct, already-proven role here: evaluate this as a corporate opportunity, record the Decision, optionally hand off to `e3d-pilot` (a real but *lightweight* mechanism — confirmed earlier today that `e3d-pilot`'s handoff only appends a short research-topic hint to the target repo's config; it does not force `e3d-pilot` to build a specific spec). Should not be a runtime dependency for a paying customer's scan — already the conclusion reached for the Codebase Scan spec, applies identically here.

### `e3d-pilot`

Already investigated in depth today for the Codebase Scan spec, and the finding transfers directly: **do not assume `discover`/`ideate` are useful here either, for the same reasons.** `discover` reads git history/docs/issues/TODOs, not structured business intake; `ideate`'s scoring vocabulary (Attraction/Retention/Revenue, consumer-growth categories) doesn't match this product's opportunity taxonomy any better than it matched the Codebase Scan's. The reusable piece is the same as before: the scoring-fanout *pattern* (`lib/scoring/fanout.sh` — independent multi-role LLM evaluation, code owns the final rank) — a good approach to carry into this product's own scoring stage, not a component to import.

### Existing report-generation systems

**`e3d-netdoctor` is the closest and most valuable existing precedent in the whole ecosystem for this product — closer than `e3d-pilot`.** It's a shipping, tested, paid-report product: deterministic rule-based verdict + LLM-generated narrative, structured JSON output (`{ payment, findings, narrative }`), multiple delivery formats (`--format markdown|html`, `--output <file>`, `--to <email>` — opt-in email delivery), and the idempotent credit-payment gate described above. `e3d-cast`/`e3d-pod2vid` are relevant for report/media generation at a UI-product level (wallet-paid podcast-to-video) but are a heavier, differently-shaped pipeline than needed here. `e3d-maps` and its "product-payment" pattern for Maps API credits is a second working precedent for the same credit-based commerce model — and, per the corrected §1/§2 finding, these products' Stripe *card* option runs through the same `spacepacket` platform as their crypto/wallet option, not a separate system.

---

## 3. Existing Reusable Infrastructure (summary)

- The E3D credit-payment client pattern (`e3dPaymentsClient.js`, modeled on `e3d-agent/src/e3d/payments-client.ts`) — idempotent, fail-closed, per-product server registration.
- `e3d-applied`'s contact-form server-action pattern for new form/intake handling.
- `e3d-corp`'s Event/Opportunity/Proposal/Decision pipeline for corporate approval (already directly exercised, proven working today).
- The scoring-fanout *pattern* from `e3d-pilot` (approach, not code, to reuse).
- `e3d-netdoctor`'s report-shape precedent (structured JSON + optional formatted/emailed delivery) as a template for report generation and delivery.

## 4. Missing Required Infrastructure

- Any card-based checkout (Stripe or otherwise) — zero existing code.
- A `/products` page or any product-catalog structure in `e3d-applied` — doesn't exist.
- A durable data layer for `e3d-applied` (customer/order/job/report state) — doesn't exist.
- Structured business intake UI — doesn't exist (only the unrelated contact form).
- Any analysis pipeline matching this product's needs — `e3d-pilot`'s discover/ideate don't transfer, same finding as the Codebase Scan.
- Any queue/worker pattern connecting AWS state to Mac-Mini-side (or any) analysis compute — doesn't exist.
- Report hosting/authenticated per-customer access — doesn't exist.

---

## 5. Manual V0 vs. Automated V1

This split is the right call, and this review sharpens exactly what each should test.

**Manual V0** — validated commercial-consulting-adjacent hypotheses only: will a stranger pay a modest amount sight-unseen; what intake questions actually produce useful answers; what report shape/depth customers value; which opportunity categories recur; what customers call actionable; which recommendations lead to follow-up work. This does **not** validate anything about automation reliability, scoring reproducibility, or unattended scale — those are V1-only questions, and no amount of manual V0 success answers them.

**Automated V1** — validates: can the pipeline generate consistently useful, non-generic recommendations without Chris; is scoring reliable/reproducible; does deterministic report validation actually catch bad output; can acquisition + fulfillment run without Chris performing every scan personally.

**Recommended manual V0, concretely** (this is new, specific guidance beyond the earlier spec's vaguer version):
- **How**: a real landing section (even a single page, or a section on an existing page — no `/products` route needs to exist yet) describing the offer; payment via `spacepacket`'s existing product-payments platform, registered with Stripe enabled as the default UX shown to customers (§25) — real checkout, not a throwaway mechanism, and not the crypto/wallet path, specifically because forcing a non-crypto-native SMB audience through a wallet-connect flow at this stage would contaminate the very hypothesis being tested (would "nobody bought this" mean "bad product" or "hated the wallet flow"?); intake via a simple form (even a Google Form/Typeform) or the existing contact-form pattern; Chris manually writes the analysis using Claude directly, delivers by email or a plain doc.
- **How many users**: 5-10 real, paying customers — enough to see whether the *pattern* of what's valuable repeats, not a statistically rigorous sample.
- **What to charge**: the stated $99 hypothesis, unchanged — no reason from this review to move it before real signal exists.
- **What to record**: every intake answer given, the report actually delivered, time Chris spent per report, customer's own usefulness rating (§37), whether they said yes to a follow-up action, and — critically for the *automation* decision — which parts of Chris's manual analysis process felt mechanical/repeatable versus which parts required genuine judgment call each time. That last one is the direct input to §D/§E below (what can automate, what can't).
- **Threshold to justify V1**: at minimum, several of the 5-10 manual customers rate the report genuinely useful (4-5/5) *and* at least one converts to real follow-up work, *and* Chris's own notes show the analysis process has a repeatable structure (not "I basically improvised something different every time"). If the manual reports don't feel structurally repeatable to Chris himself, that's a sign the automated pipeline (§15-19) needs more design work before building, not less.

---

## 6-7. Core Customer Promise / Target Customer / Strategic Purpose / Business Hypothesis

Unchanged from the original framing — none of this depends on the infrastructure findings above, and it was already sound. The falsifiable hypothesis (§7 of the source doc) stands as written; this review doesn't change what would falsify it, only what it costs to test it (see §5 above, §47 below).

---

## 8. Product Architecture

```text
futco.ai (e3d-applied — new landing section, not a full /products catalog for V1)
   │
Payment: spacepacket's existing product-payments platform (REUSED —
         new product-config registration, not new checkout/webhook code;
         Stripe enabled, wallet/credit path available not default)
   │
Customer / ScanOrder (new durable state — e3d-applied has none today)
   │
Structured Intake (new — reuses e3d-applied's contact-form pattern)
   │
Scan Job (new state)
   │
   ├─────────────────────┐
   │                     │
   ▼                     ▼
Cloud model            Mac mini / local Qwen
(default — no queue      (only if a real reason emerges;
 infra exists to          no queue infra exists to support
 support Mac-mini          this safely yet — see §10)
 workers safely yet)
   │                     │
   └──────────┬──────────┘
              ▼
   Structured analysis (new pipeline, informed by but not
   built from e3d-pilot's discover/ideate)
              ↓
   deterministic scoring (new dimensions, reusing the
   fanout-scoring approach)
              ↓
           validation (new)
              ↓
       human review (Chris, at least for V1 — no existing
       review tooling to lean on, same as the Codebase Scan)
              ↓
            report (new — informed by e3d-netdoctor's
            structured-output + optional email-delivery shape)
              ↓
          customer
```

Payment is now reused, not new. Everything from Structured Intake onward is still genuinely new — that's not a reason not to build it, it's a reason the phased plan below stays paced to prove the remaining riskiest piece (analysis quality, not payment) early.

---

## 9-10. AWS / Mac Mini Boundary

No existing infrastructure supports the "AWS creates job, Mac Mini claims it outbound, posts result back" pattern — it would be built from zero if used at all. Given that, and given the Codebase Scan review's parallel finding, **default to calling a cloud model directly from wherever the analysis runs (likely AWS itself, alongside the rest of the product) rather than building Mac-Mini-worker infrastructure for V1.** There's no stated requirement here for local/private inference (unlike `e3d-trade`, which genuinely needs local GPU access) — introducing the Mac Mini adds a new failure mode (§44) and new infrastructure (a queue) to build, for no clear V1 benefit. Revisit only if a specific cost or privacy requirement emerges later.

---

## 11. Model Strategy

No change needed from the original framing — evaluate per stage (structured-output reliability likely matters more than raw capability for candidate generation and scoring; narrative/report-writing quality matters more for the final synthesis stage). No existing infrastructure locks this into one vendor either way.

---

## 12-14. Intake / Public Website Evidence / Private Integrations

Intake design (§12 source doc) is sound and reuses `e3d-applied`'s real contact-form validation/origin-check pattern as its base — no changes needed there.

**Public website crawling (§13)**: no existing safe-crawling infrastructure was found anywhere in the ecosystem to reuse — this would also be built from scratch, with real SSRF/injection risk (§33 source doc) for real but likely secondary value. Defer to V1.1 rather than V1; the marginal context from a website crawl is unlikely to be the difference between a useful and useless report if intake is well-designed, and it adds a genuinely new security surface (SSRF, prompt injection from web content) for a first version whose main open question is "will anyone buy this," not "can the report get slightly better business context."

Private integrations (§14): correctly excluded from V1 already, no change.

---

## 15-24. Analysis Pipeline / Schemas / Scoring / ROI / Build-vs-Buy / Governance / Risk / Confidence

All structurally sound as specified in the source document — none of this changes based on the infrastructure findings, since none of it currently exists to be found reusable or not. Two adjustments worth making based on real precedent:

- **Scoring**: adopt the fanout pattern confirmed reusable from `e3d-pilot` (§2 above) — multiple independent LLM evaluations across distinct roles/dimensions, deterministic code computes the final rank. Same approach recommended for the Codebase Scan; worth using consistently across both products.
- **Report structure**: `e3d-netdoctor`'s `{ payment, findings, narrative }` shape — a small deterministic/structured core plus an LLM-authored narrative wrapper — is a real, working pattern for exactly this kind of "structured facts, human-readable delivery" problem. Worth using as the report's internal shape even though the report *content* here (business opportunities, not network diagnostics) is completely different.

---

## 25. Payment and Entitlement

Corrected per §2/§1: this is not the open decision it looked like before. `spacepacket` already runs a real, product-agnostic payment platform that supports **both** card payment (Stripe, via `productRegistry.js`'s `stripe: { enabled, packs }` block) and crypto/wallet credit purchases through the same product config, with real idempotency, webhook fulfillment, and receipt emails already built for both paths — `netdoctor` and `cast` already use it today.

**Recommendation: register the AI Opportunity Scanner as a new product against this existing platform, with Stripe enabled and the crypto/wallet path available but not the default UX shown to a non-crypto-native SMB customer.** That's the actual smallest honest move now — not "build a Payment Link with no code" (still true that it requires no *new* payment code, but there's no longer a reason to treat this as a separate, disposable V0-only hack when the real product-registered Stripe flow costs about the same to stand up and doesn't need to be thrown away). Concretely: a `spacepacket` product-config change (real work, in a different repo — see §41) plus whatever price/credit-pack entry represents "$99 = one scan," reusing `stripePayments.js`'s Checkout/webhook/fulfillment and `stripeReceiptMailer.js`'s receipt email as-is.

This doesn't change the recommendation to run a manual V0 first (§5, §48) — the risk that mattered there was never "can we take payment," it was "will anyone pay and is the report any good." It does mean the manual V0 no longer needs its own disposable payment mechanism; it can use the real product-registered Stripe flow from day one at near-zero extra cost.

---

## 26-28. Entitlement/Order Model, Job Lifecycle, Failure/Retry/Idempotency

Design as specified in the source document (§28, §44-45) — sound state machine, sound idempotency requirements. Correction: the *payment/credit* entitlement side of this is largely covered by `spacepacket`'s existing `productPaymentsService.js` ledger (`grantCredits`/`spendCredits`/`getKeyMetadata`) once registered as a product (§25) — don't build a second, parallel credit/entitlement system. What's still genuinely new and product-specific: the *scan* order/job/report lifecycle itself (intake status, analysis status, report status) — that state has no existing equivalent anywhere and should live wherever this product's own durable data ends up (§41), separate from but referencing the payment platform's credit/entitlement record.

---

## 29-30. Security / Privacy / Website Crawling

Real but smaller security surface than the Codebase Scan (no untrusted-code-execution risk), still real: prompt injection from customer free-text intake (treat as data, not instructions — same pattern already correctly used elsewhere in `e3d-corp`'s roles today), report access authorization (unguessable URLs, customer-A-cannot-see-customer-B), standard webhook/payment security regardless of which payment option is chosen. Website crawling security (§33 source doc) only becomes relevant if that feature is built — deferred per §13 above.

---

## 31-38. Telemetry / Distribution Attribution / Customer Feedback / Cost Tracking / Success Metrics / Go-No-Go Criteria / Upsells / Relationship to Services

All as specified in the source document — sound, and none of it depends on today's infrastructure findings changing anything. Worth explicitly aligning telemetry event names and feedback-question wording with the AI Opportunity Scanner's earlier spec draft and the Codebase Scan spec, since all three products will eventually want comparable cross-product metrics if more than one ships.

---

## 39. Relationship to Future AI Build Spec

Same finding as the Codebase Scan spec: `e3d-pilot`'s `draft`/`negotiate` stages are the genuinely reusable piece for a later "turn this selected opportunity into an implementation-ready spec" product — real, human-approval-gated, already produces CSR-ready phased specs. New plumbing still needed to let a customer-selected opportunity (from a report this product generates, not from `e3d-pilot`'s own `ideate`) enter `draft` as if it were an approved idea. Don't build this now; the seam is understood and small enough to revisit later.

---

## 40. Shared Infrastructure Future Products Could Reuse

Genuinely shareable across this product and the Codebase Scan (build once, in whichever ships first): customer identity, checkout/entitlement pattern (whichever payment rail gets chosen here), job lifecycle pattern, report hosting/auth, telemetry pipeline, feedback collection. Confirmed independently by both spec reviews arriving at the same list — a strong signal this is the right shared layer to build deliberately reusable, not an accident of two similar documents.

---

## 41. Repo/Service Ownership

`e3d-applied` is the right home for the customer-facing surface (landing content, intake, report display) — it already has the closest-fitting patterns (contact-form action, booking-URL config) and is the confirmed production home for `futco.ai`/`applied.futco.ai`. Durable scan/report state needs a new, small data layer that doesn't exist in that repo today. **Real cross-repo dependency, now concrete rather than hypothetical: checkout itself should call `spacepacket`'s existing payment API (`/api/payments/products`, `/api/payments/credits/*`, the Stripe pack endpoints) rather than `e3d-applied` building its own Checkout session/webhook handling — matching this ecosystem's own "integrate over API, not a source import" convention, already applied consistently to every cross-repo integration built this session.** That means Phase 1 of this product depends on a `spacepacket` product-registration change landing first (§25) — sequence accordingly (§42). No Mac-Mini-queue pattern is being built (§9-10), so there's still no strong pressure toward a separate analysis-worker service; the smallest architecture remains `e3d-applied` plus its new data layer, calling a cloud model directly, with checkout calling out to `spacepacket`.

---

## 42. Implementation Phases

```text
Phase 0   Source-of-truth verification (this document; re-confirm e3d-applied/
          spacepacket specifics at actual build time since they move independently
          of this spec)
Phase 1   spacepacket: register the Scanner as a product (config block, price/
          credit-pack entry, Stripe enabled) — cross-repo dependency, do this
          first since Phase 2 needs it live
Phase 2   e3d-applied: landing content + checkout calling spacepacket's payment
          API (no new checkout/webhook code — validates §5's manual V0 directly)
Phase 3   Durable data layer (customer/order/job/report — smallest reasonable
          addition to e3d-applied) + structured intake, gated on a valid paid order
Phase 4   Analysis pipeline: candidate opportunity generation (new prompt/schema,
          not e3d-pilot's ideate)
Phase 5   Deterministic scoring (fanout pattern, new dimensions) + report validation
Phase 6   Report generation and authenticated delivery
Phase 7   Human review step (Chris) + telemetry + feedback collection
Phase 8   Security/failure-recovery hardening
Phase 9   Production launch, review criteria for removing mandatory human review
```

Phase ordering now front-loads the one thing still worth de-risking early — real customer report quality — since payment is reuse, not new engineering, and can be stood up in the first two phases.

---

## 43. Acceptance Criteria

Same substance as source doc §51-54 — sound, no changes needed given they were already written to be infrastructure-agnostic. Two additions worth calling out explicitly given today's findings: (1) a test that a duplicate `spacepacket` webhook/fulfillment event cannot create a second entitlement — this should mostly be inherited for free from the platform's existing idempotency (real, confirmed in its ledger code), but verify it explicitly for this product's registration rather than assuming; (2) a test that the report generation stage fails closed (no report, clear customer-facing message) rather than producing a low-confidence report dressed up as confident, matching the "insufficient information to estimate reliably" principle already in §20 of the source doc.

---

## 44. V1 Non-Goals

Unchanged from source doc §49 — all still correct, and now additionally: no Mac-Mini-worker/queue infrastructure (§9-10), no public-website-crawling (§13), no *new* payment system when `spacepacket`'s existing one covers this (§25).

---

## 45. Estimated Implementation Complexity

Smaller than the previous version of this review implied. Genuinely new: durable data layer, intake UI, the analysis pipeline (prompt/schema/scoring), report generation/delivery. Genuinely reused, and larger than previously assessed: the entire payment/checkout/webhook/fulfillment/receipt-email stack (`spacepacket`'s product-payments platform, via a config-registration change, not new code), the fanout-scoring approach, the contact-form pattern, and `e3d-corp`'s existing approval/event pipeline for the corporate-opportunity side. The remaining complexity is concentrated almost entirely in the analysis pipeline and report quality — which was always the harder, more uncertain problem anyway.

---

## 46. Major Risks

**Technical**: report quality — can a structured pipeline over ~15 minutes of intake produce recommendations a technical-enough business owner finds genuinely non-obvious, reliably, without Chris's judgment in the loop? This is untested by anything built so far and is the same category of risk the manual V0 is specifically designed to surface before automating. This is now the dominant technical risk, unambiguously, with the payment risk resolved.

**Commercial**: the same distribution/trust risk Fable identified for the earlier version of this spec — nothing here addresses *why* a stranger lands on the page and pays, only what happens after they decide to. Still unresolved, still the single biggest open question, unaffected by today's payment-infrastructure correction.

**Infrastructure**: reduced by this review, not eliminated — registering a new product against `spacepacket`'s payment platform is real cross-repo coordination work (a different repo, not checked out for editing as part of this product's own implementation phases), and the default UX choice (card vs. wallet) still needs to be made deliberately (§25), just from a much stronger starting position than assumed before.

---

## 47. Success Metrics

North-star metric from the source doc (§47) — *"percentage of customers who identify at least one recommendation they genuinely intend to implement"* — is a good, sharp choice; no better alternative found during this review. Keep it as the single number to watch.

---

## 48. Go/No-Go Recommendation

**No-go for the fully automated analysis pipeline right now. Go for the manual V0, using `spacepacket`'s real product-payments platform (Phase 1-2) rather than a disposable Payment Link.** The correction in §25 removes the reason to treat V0's payment mechanism as throwaway — registering the product for real costs about the same as a Payment Link and doesn't need to be rebuilt later. What's still gated on real signal is everything from intake onward: the analysis pipeline, scoring, and report generation (Phase 3+) shouldn't be built until the manual V0 shows the report itself is worth automating.

## 49. What `e3d-corp` Should Approve Next

Approve the manual V0 (real product-registered checkout via `spacepacket` + simple intake + Chris manually analyzing and delivering 5-10 reports), with the recording requirements in §5 built in from the first customer. That includes approving the cross-repo `spacepacket` product-registration work (§25, Phase 1) as part of the V0, since it's now the cheap, reusable part rather than a separate later decision. Do not approve Phases 3-9 yet — revisit once the V0 threshold in §5 is actually met or clearly missed.

---

## 60. Final Decision Questions

### A. Is the AI Opportunity Scanner still the best first self-service FutCo AI product, after inspecting actual source code?

Yes, relative to the Codebase Opportunity Scan — that review's own conclusion (§37 of that spec) was not to build it before this one, for the same reasons that hold up here: smaller security surface, audience closer to FutCo's existing positioning, and this product's commercial hypothesis (will a business pay for an automated opportunity report) is the one worth testing first since it's shared, in substance, by both products.

### B. What is the smallest version that honestly tests the core commercial hypothesis?

The manual V0 in §5 — real checkout via `spacepacket`'s existing payment platform (a config registration, not new code), a simple form, Chris manually producing the first 5-10 reports.

### C. Should we run a manual V0 first? If yes — how, how many, what price, what's manually produced, what's recorded, what threshold triggers V1?

Yes. Fully specified in §5 above, updated per §25: real product-registered payment via `spacepacket` (Stripe enabled), not a disposable Payment Link; 5-10 customers; $99 unchanged; Chris personally produces each report via Claude and delivers by email/doc; record every intake answer, the delivered report, time spent, usefulness rating, follow-up conversion, and which parts of the process felt mechanical vs. judgment-driven; move to full automation only if several customers rate it genuinely useful, at least one converts to follow-up work, and Chris's own process shows a repeatable structure.

### D. Which pieces of the automated V1 already exist?

More than originally assessed: `spacepacket`'s entire product-payments platform (checkout, webhook fulfillment, idempotent credit ledger, receipt emails — needs product registration, not new payment code), `e3d-corp`'s approval/event pipeline for the corporate-opportunity side, `e3d-applied`'s contact-form/validation pattern, and the scoring-fanout approach from `e3d-pilot` (as a pattern, not a component).

### E. Which pieces must be built from scratch?

Narrower than originally assessed: the landing content, the durable scan/order/report data layer, structured intake UI, the entire analysis pipeline (candidate generation, scoring dimensions, report synthesis), report hosting/delivery, and telemetry. Payment is no longer on this list.

### F. What is the highest-risk technical assumption?

That a structured, code-owned pipeline (intake → candidate generation → scoring → report) can produce recommendations a real business owner finds genuinely non-obvious and worth paying for — reliably, without a human's judgment in the loop. Nothing built anywhere in this ecosystem today demonstrates this; it's exactly what the manual V0 is designed to surface honestly before committing engineering effort to automating it.

### G. What is the highest-risk commercial assumption?

Distribution and trust — will a stranger who's never heard of FutCo actually land on this offer and decide to pay, sight-unseen, for an unfamiliar boutique brand's automated business analysis. Nothing in this spec, the earlier draft, or Fable's review of that draft has addressed this directly; it's the load-bearing unknown underneath everything else.

### H. What should `e3d-corp` approve next?

The manual V0 exactly as scoped in §5/§49 — nothing beyond it yet.
