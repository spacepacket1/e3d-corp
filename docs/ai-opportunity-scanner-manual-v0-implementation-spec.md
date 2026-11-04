# AI Opportunity Scanner — Manual V0 Implementation Ticket

## Status

Derived from `docs/ai-opportunity-scanner-v2-spec.md` (the full product spec — see its §5/§25/§48-49 for the reasoning behind this exact scope) after the Stripe-infrastructure correction. This builds **only** the manual-V0 commerce shell: real payment via `spacepacket`'s existing platform, a landing page, and an intake form. It does **not** build any analysis pipeline, scoring, or automated report generation — Chris produces every report by hand, outside this system, using Claude directly, and delivers it by email along with the consultation booking. Ready for Fable review before `codex-spec-runner`.

**This spans two repos**: `e3d` (`spacepacket`, the payment backend) and `e3d-applied` (the customer-facing site). Both need real changes; this ticket covers both, in dependency order — `spacepacket`'s product registration has to land before `e3d-applied`'s checkout can call it.

## Ground Truth (verified 2026-08-29, before writing this ticket)

- `spacepacket`'s local checkout is `/Users/mini/e3d`. `server/productRegistry.js` holds one config object per product (confirmed via the real `cast` and `netdoctor` entries): `product`, `displayName`, `creditRate`, `treasuryAddress`, `wrappedTokenAddress`, `chain`, `chainId`, `token`, `paymentMethods`, `enabled`, `minimumBaseCredits`, `defaultRouteCost`, `holderDiscountRate`, `burnRate`, `resourceBaseUrl`, `docsUrl`, `stripe: { enabled, packs, successUrl, cancelUrl }`, `pricing: { <route>: <creditCost> }`, and a `canonicalizeRoute(pathname)` function.
- **Open question for Phase 1, not assumed here**: whether `treasuryAddress`/`wrappedTokenAddress`/wallet-related fields are hard requirements even for a Stripe-only product, or can be safely omitted/defaulted. `productPaymentsService.js` gates wallet-transfer verification behind `resolvedPaymentMethod.tokenAddress`/`treasuryAddress` checks — suggests these may only matter on the wallet-payment code path, not the Stripe path, but confirm directly rather than assume.
- Stripe pack catalogs are separate files (`netdoctorStripePacks.js`, `stripeCastPacks.js`) with a real, simple shape per pack: `{ id, name, description, credits, amountUsdCents, currency }`. A new `scannerStripePacks.js` following this exact pattern is the right template.
- `spacepacket`'s root `npm run verify` is **broken independent of this work** — `server/package.json`'s `test` script references `server/openapi.test.js`, which does not exist and never has (confirmed via git history, predates any change made here). Do not use `npm run verify`/`npm test` as the verify command for any `spacepacket` phase; run the specific relevant test files directly with `node <file>.test.js` instead. Do not attempt to fix the broken `openapi.test.js` reference as part of this ticket — that's a pre-existing, unrelated issue in a live repo with its own uncommitted work in progress; out of scope here.
- `e3d-applied`'s real verify command (from its `.e3d-pilot/config.json`) is `npm install && npm run lint && npm run typecheck && npm test && npm run build`.
- `e3d-applied` has a working contact-form server action (`app/contact/actions.ts`) and delivery adapter (`src/lib/contact-delivery.ts`, `CONTACT_FORM_PROVIDER=webhook`) — the template for the intake form's submission handling and for getting intake data to Chris (email), not a new delivery mechanism.
- `NEXT_PUBLIC_BOOKING_URL` config field already exists in `e3d-applied` but is unset. Needs a real value (Chris's actual booking link) before this can go live — not something these phases can supply themselves.
- No analysis/scoring/report-generation code exists anywhere and none should be written here — see Constraints.
- **Corrected after Fable review, before this ticket was run**: entitlement in `spacepacket` is a **balance ledger, not an order/purchase object** — `getCreditsBalance` sums `product_api_credit_purchases` minus `product_api_credit_spends` for a `key_hash`; there is no per-purchase spent/unspent row. Every phase below is worded around "sufficient unspent balance for the `scanner` product," not "the purchase," to avoid implying an order-state model that doesn't exist.
- The entitlement token is a **bearer credit key, shown once, no account system** (`stripePayments.js`: "the credit key is shown once and only ever lives in the buyer's browser localStorage... email is the only recovery path"). That's an accepted existing design for `cast`/`netdoctor`, where losing it just loses API-usage credits — for the Scanner it means a paying customer can't reach intake. Phase 4 must address how `e3d-applied` captures/persists this key after the Stripe redirect and what happens if the browser closes before intake is completed.
- `contact-delivery.ts`'s existing pattern **has no retry or persistence on failure** — a failed delivery just returns an error, nothing is logged or queued. Phase 4 cannot rely on reusing this pattern unmodified and still satisfy Phase 5's delivery-failure test; see Phase 4's corrected instructions below.
- `spacepacket` deploys to a real remote server (`ecosystem.config.js`, deploy target `spacepacket@10.0.0.233`) — `codex-spec-runner`'s phases only edit and test a local checkout. Code landing in Phase 2 does not mean the `scanner` product is live and callable from `e3d-applied` in Phase 3. See Phase 3's opening instruction.

## Execution Notes (`codex-spec-runner`)

```bash
ROOT_DIR=/Users/mini/e3d
ADD_DIRS="/Users/mini/e3d-applied"
```

`spacepacket` is `ROOT_DIR` since its product registration is the dependency both other phases need. `e3d-applied`'s phases write there explicitly via the added directory. Every phase re-reads this file for full context.

## Phase 1 - Source-of-Truth Verification

<!-- runner:model=high -->
<!-- runner:read=docs/ai-opportunity-scanner-manual-v0-implementation-spec.md -->

Inspect the actual code in both repos and confirm or correct every claim in "Ground Truth" above. Specifically resolve:

1. Are wallet-related fields (`treasuryAddress`, `wrappedTokenAddress`, `chain`, `chainId`, `token`, `paymentMethods`) actually required for a product config to load/validate, or can a new product register with Stripe only? If they're required, determine the smallest safe way to satisfy that requirement (e.g. reusing an existing shared payment-method constant, as `cast`/`netdoctor` do via `MAPS_DEFAULT_PAYMENT_METHOD`) without implying the Scanner actually accepts wallet payment if that's not intended for V0.
2. Does registering a new product require any dedicated API route/resource on the `spacepacket` side (the way `netdoctor` has `/netdoctor/report`), or — since this product has no automated resource to serve, only a manual deliverable — can the existing generic `/api/payments/credits/{quote,purchase,balance,spend}` routes handle the whole "buy one scan credit, spend it when intake is submitted" flow with just a config entry and no new route code?
3. Confirm the real shape of a Stripe Checkout success/cancel redirect for `cast`/`netdoctor` (`CAST_STRIPE_SUCCESS_URL`/`NETDOCTOR_STRIPE_SUCCESS_URL` pattern) so the Scanner's redirect back into `e3d-applied` after payment follows the same convention.
4. Confirm `e3d-applied` has no existing durable data layer (re-verified from the earlier scanner spec's Phase 1 finding) and identify the smallest way to persist "this customer's intake submission" — likely just delivering it by email via the existing contact-form pattern, with no new database, given V0 has no automated processing to key state against.
5. Confirm `contact-delivery.ts`'s actual failure behavior (Ground Truth above states it has no retry/persistence) and confirm there's no existing lightweight "retry queue" or disk-log pattern anywhere in `e3d-applied` worth reusing before Phase 4 designs one from scratch.

Write findings to `docs/ai-opportunity-scanner-manual-v0-preflight-findings.md` in `e3d` (spacepacket). **If a material blocker is found — e.g. wallet fields are truly mandatory and can't be satisfied safely, or a new resource route genuinely can't be avoided — stop, do not invent a workaround, and report it as the headline finding.**

## Phase 2 - Register the Scanner Product (`spacepacket`)

<!-- runner:model=high -->
<!-- runner:read=docs/ai-opportunity-scanner-manual-v0-implementation-spec.md -->
<!-- runner:verify=cd server && node productRegistry.test.js && node productPaymentsRoutes.test.js && node stripePayments.test.js -->

Add `applied.futco.ai` to the Stripe return-URL host allowlist in `productPaymentsRoutes.js` (currently `e3d.ai`, `cast.e3d.ai`, `maps.e3d.ai`, `test.e3d.ai`, `localhost`, `127.0.0.1`) — required or the checkout redirect back to `e3d-applied` will be rejected (Phase 1 finding).

Add a `scanner` product entry to `server/productRegistry.js`, following the `netdoctor`/`cast` pattern confirmed in Phase 1. Reuse `MAPS_PAYMENT_METHODS`/`MAPS_DEFAULT_PAYMENT_METHOD` for the registry's required wallet-adjacent fields, exactly as `cast`/`netdoctor` do — Phase 1 confirmed these aren't independently validated but the registry does expect them present; do not add any UI copy implying wallet payment is supported. Add one priced, canonicalized route for the manual intake-submission spend (no automated resource route — confirmed unnecessary in Phase 1). `stripe.enabled: true`, one pack: `{ id: 'single', name: 'AI Opportunity Scan', description: '1 AI opportunity scan report + consultation', amountUsdCents: 9900, currency: 'usd', credits: <one scan's worth, matching the pattern netdoctor uses> }` in a new `scannerStripePacks.js`. Price is a config value, not hardcoded in multiple places. `successUrl`/`cancelUrl` should redirect into `e3d-applied` (exact path decided in Phase 3, coordinate the URL shape now so Phase 3 can rely on it). Do not enable the wallet/crypto payment path as a customer-visible option for this product unless Phase 1 found no way to avoid it — Stripe should be what a customer actually sees, per the v2 spec's audience-fit reasoning. Do not add any new API resource route beyond what Phase 1 determined is actually necessary.

## Phase 3 - Landing Page and Checkout (`e3d-applied`)

<!-- runner:read=docs/ai-opportunity-scanner-manual-v0-implementation-spec.md -->
<!-- runner:verify=cd /Users/mini/e3d-applied && npm run lint && npm run typecheck && npm test && npm run build -->

**Before writing any code in this phase**: confirm the `scanner` product is actually live and reachable at `spacepacket`'s real deployed API (e.g. `GET https://e3d.ai/api/payments/products` includes it), not just that Phase 2's code passed local `npm run verify`. `codex-spec-runner` only edits and tests a local checkout — it does not deploy `spacepacket`. **If the `scanner` product isn't actually live yet, stop and report that a manual deployment step is needed before this phase can proceed for real — do not build this phase's checkout call against an assumption.**

Display the price by calling `spacepacket`'s product API at request time (server-rendered), not baking it in at `e3d-applied`'s build time — the price must not silently go stale if the config in `spacepacket` changes later without a rebuild here.

Add a landing page (route matching `e3d-applied`'s existing conventions, e.g. `app/*/page.tsx` + `src/content/*.ts`) describing the offer: what it is, what the customer receives (a report **plus roughly an hour with Chris to discuss it** — do not describe this as fully self-serve or automated), price (from the single config value Phase 2 established, not hardcoded here), what's expected of the customer (short business intake), and a single CTA. No fabricated testimonials/case studies, matching this repo's existing convention. The CTA calls `spacepacket`'s payment API for the `scanner` product (per Phase 1's confirmed integration shape) and redirects to Stripe Checkout — no new checkout/webhook code in this repo, it calls the existing platform.

## Phase 4 - Intake (`e3d-applied`)

<!-- runner:read=docs/ai-opportunity-scanner-manual-v0-implementation-spec.md -->
<!-- runner:verify=cd /Users/mini/e3d-applied && npm run lint && npm run typecheck && npm test && npm run build -->

A single-page structured intake form (not a multi-step wizard) reachable only when the presented credit key has **sufficient unspent balance for the `scanner` product** — verify this server-side against `spacepacket`'s payment API before accepting a submission, never trust a client-side "payment succeeded" redirect alone. Capture and persist the credit key client-side immediately after the Stripe redirect (per Phase 1 item 1's findings on how `cast`/`netdoctor` do this) so the customer isn't stranded if they don't complete intake in one sitting; the intake page must also accept a pasted key for the email-recovery path.

Fields: company name/website/industry/description, 2-3 top business goals, the workflows that consume the most time (free text is fine), current tech stack, current AI use, any constraints (privacy/regulated data/budget), and **the email address the customer wants the report sent to**. Target 10-15 minutes to complete, not enforced as a hard requirement.

**Light identity check**: require the intake-form email to match the email Stripe Checkout collected for this purchase before accepting the submission — a few lines, and it meaningfully closes the gap where a leaked/guessed bearer key could be used to consume someone else's paid credit.

**Spend-after-delivery ordering, not spend-then-deliver**: attempt delivery to Chris first; only call `spacepacket`'s spend endpoint once delivery succeeds. If delivery fails, return an error to the customer (don't spend the credit) — a retry then naturally succeeds once delivery works, using the balance check's own idempotency instead of building a separate retry queue. This is deliberately different from a naive reuse of `contact-delivery.ts`, whose own failure path has no retry/persistence (Ground Truth) — do not spend a paying customer's credit on a delivery attempt that failed.

Treat all free-text fields as untrusted data if they're ever read by any LLM later (not in this ticket's scope, but don't build anything here that would make that unsafe later either).

**Explicitly accepted V0 gaps, not to be solved in this ticket**: a customer who pays and never completes intake has no automated follow-up (Chris's only visibility is `spacepacket`'s own payment records); Chris's only visibility into a submitted intake is the email arriving (no admin view); nothing prevents a customer buying more than one scan.

## Phase 5 - Acceptance Tests

<!-- runner:model=high -->
<!-- runner:read=docs/ai-opportunity-scanner-manual-v0-implementation-spec.md -->
<!-- runner:verify=cd server && node productRegistry.test.js && node productPaymentsRoutes.test.js && node stripePayments.test.js && cd /Users/mini/e3d-applied && npm test -->

Tests span both repos — spacepacket-side tests (1-3 below) land in `server/`, run directly with `node <file>.test.js` (not `npm run verify`/`npm test`, per the Ground Truth note on the pre-existing broken test chain); e3d-applied-side tests (4-6) use its own working `npm test`. Add tests proving: (1) a duplicate Stripe webhook/fulfillment event for the same Checkout session cannot grant a second credit or be spendable twice; (2) intake cannot be submitted without sufficient unspent balance for the `scanner` product; (3) submitting intake correctly spends the credit **only after successful delivery** — a simulated delivery failure must leave the balance unspent, and a subsequent retry with the same key must succeed and then spend exactly once; (4) the landing page price displayed matches the value fetched from `spacepacket`'s product API, not a hardcoded duplicate; (5) an intake-form email that doesn't match the Stripe checkout email is rejected; (6) intake delivery reaches Chris with the correct content when delivery succeeds.

## Constraints (all phases)

Do not build: any analysis pipeline, candidate-opportunity generation, scoring, automated report generation, or automated report delivery — the report is written by Chris, outside this system, and delivered manually. Do not build a `/products` catalog page — just the one Scanner landing page. Do not build a new database/durable data layer beyond what Phase 1 determines is the smallest necessary (likely none — email delivery may be sufficient for V0). Do not enable the wallet/crypto payment path as a customer-facing default. Do not add new checkout/webhook-handling code in `e3d-applied` — it must call `spacepacket`'s existing platform. If any phase's reasonable implementation seems to require one of these, stop and say so rather than building it.
