# U.S. Financial Stress Monitor — Implementation Spec

Status: Draft v3 — revised after round-1 multi-model review (codex + grok); ready for round 2
Owner: Chris Bloom
Author: Claude, grounded in direct code investigation across `e3d-corp`, `e3d`, `e3d-applied`, and `e3d-mobile` (2026-09-02)

---

## 0. How to read this document

This spec follows the established spec-first workflow: write → circulate to other AIs for review → converge → hand to `codex-spec-runner`. It spans **two repositories for V0 build work** (`e3d`, `e3d-corp`) plus one presentational repo (`e3d-applied`) — see §25 for how that changes execution.

Every claim about "what already exists" in §3 was verified against real code (research passes, direct file reads, and a round-1 review pass by both `codex` and `grok` against the actual repos). Round 1 caught a stale claim (§3.1, corrected below) and a real design flaw in the original architecture (§4, §9, §12 — the pipeline's job-hosting and authority-level assignment both changed as a result). Where a prior assumption turned out to be wrong, this doc says so explicitly rather than quietly fixing it.

---

## 1. Executive Summary

Chris has been manually running a ChatGPT workflow that periodically evaluates U.S. Treasury/funding-market/Fed-policy stress, produces a 1–10 "Financial Stress Score" with a plain-English explanation, and tells him when — and only when — something material changed. He considers this notification the single most useful signal he's built anywhere, more useful than anything currently in E3D.

This spec productizes that workflow as an event-driven system, branded as a FutCo intelligence product. The core deliverable is not a dashboard — it's a **canonical, versioned, evidence-backed event** (`FinancialStressChangeEvent`) that a human reviews and approves before it fans out to a dashboard, a push/email notification, and a newsletter issue.

Per Chris's explicit request, the scoring itself is not a single model call — it's a **three-stage pipeline across three different AI providers** (§8): OpenAI's deep-research models do the actual live research and produce a draft score; Grok independently re-derives its own score from the same evidence, without seeing OpenAI's number, as a genuine cross-check; Claude synthesizes both into the narrative Chris actually reads, explaining any disagreement rather than silently averaging it away. Every stage's output rides along in the canonical event — nothing about how to weigh disagreement between models is decided by code.

The most important finding from investigation, revised after round-1 review: **the original FutCo.ai-vs-E3D.ai split doesn't map onto what actually exists, but not in the direction the first draft of this spec assumed either.** `futco.ai` redirects to `applied.futco.ai`, which turns out to already be a real, live *product* surface (an "AI Opportunity Scanner" with payments and webhook delivery), not the zero-backend marketing site this spec's first draft claimed — that claim was stale, corrected in §3.1. Meanwhile `e3d.ai` (the `e3d` hub), not `e3d-corp`, is the right home for the actual running pipeline: it has durable ClickHouse-backed storage and a real production server, versus `e3d-corp`'s local-JSONL event store, which round-1 review correctly flagged as too weak a foundation to host live webhook receipt and job orchestration. `e3d-corp` keeps the role it's genuinely built for — the human-approval gate — reusing its multi-provider LLM abstraction and web-research/evidence layer as *library code*, not as the host of the running job. See §4 for the corrected split.

---

## 2. Product Thesis

The product answers one question: **how close is the U.S. financial system to a point where policymakers are forced to act?**

This is explicitly not recession probability, VIX, inflation, or Treasury yields in isolation. It's closer to *proximity × severity × probability of policy-forcing financial-system stress* — a judgment call that requires synthesizing Treasury-market mechanics, funding-market plumbing, and Fed/Treasury behavior, which is exactly what Chris's ChatGPT workflow already does by hand.

**V0 preserves AI judgment rather than replacing it with a deterministic formula.** The existing ChatGPT workflow is the V0 reference implementation, not a throwaway prototype — the production system's job in V0 is to reproduce it faithfully via API, store enough history to eventually formalize scoring, and get a human in the loop before anything goes public. Formalization is a multi-version roadmap (§23), not a day-one requirement.

---

## 3. Existing-System Audit

### 3.1 Brand/domain reality (corrected after round-1 review — this section was wrong in draft v1)

`futco.ai` 301-redirects to `applied.futco.ai` — there is no independent "futco.ai products" surface distinct from the site at that hostname. Draft v1 of this spec additionally claimed `e3d-applied` has "zero database, zero live-data integration, zero existing product-serving capability," sourced from a knowledge-base entry last reviewed 2026-08-06. **That claim is false and was caught in round-1 review**: `e3d-applied` now runs a real, live product — the **AI Opportunity Scanner** — with its own intake flow, live pricing/checkout via Stripe (`src/lib/scanner-payments.ts`), credit verification and spend (`app/ai-opportunity-scanner/intake/actions.ts`), authenticated outbound webhook delivery to another service (`src/lib/scanner-intake-delivery.ts`), and its own API routes (`app/api/scanner-intake/status/route.ts`, `app/api/scanner-intake/claim/route.ts`). It genuinely has no local database — state lives elsewhere, called out to over HTTP — but it is unambiguously a dynamic product frontend already, not a static marketing shell.

This matters beyond just correcting a fact: it means `e3d-applied` already has a *proven, working pattern* for "Next.js page calls out to a backend API for real product state and payments" — which directly informs the dashboard presentation decision in §13, and somewhat narrows how strong an argument "e3d-applied can't host anything real" ever was for §4's split. The underlying conclusion in §4 (engine and durable state live in `e3d`/`e3d-corp`, not `e3d-applied`) still holds, but for a different, better-grounded reason: it's about where the *research/scoring/evidence* infrastructure already exists, not about `e3d-applied` being incapable of dynamic behavior.

### 3.2 E3D hub (`e3d` / `spacepacket` / `ripple` — three names, one codebase, GitHub `e3d`) newsletter infra

`buildDB/write_newsletter_v3.js` is a single hardcoded daily pipeline: `writeNewsletterV3()` locks to a fixed "previous calendar day" window (`getPrevDayWindow()`), pulls E3D-specific stories/theses from ClickHouse, and has no parameter for "write about topic X." There is **no "newsletter issue" database entity** — delivery is filesystem-based: the script writes `newsletter_<timestamp>.html` into a directory, and `server/send_newsletter.js`'s `getMostRecentNewsletter()` just globs that directory and sends whichever file sorts newest. A second, differently-themed newsletter cannot share this "latest file" mechanism without racing the existing daily E3D newsletter for the send slot. Delivery is Office365 SMTP via `nodemailer` (`support@e3d.ai`) — not SES, despite `@aws-sdk/client-sesv2` existing elsewhere in `server/package.json`. Subscribers come from MongoDB (`User.find({ subscribeNewsletter: true })`). One latent bug worth fixing while anyone is in this code: `sendEmail(user.username, content)` passes `username`, not `user.email`, as the recipient address.

The LLM call inside this specific script (`chatCompletion()`, gated by `parseLlmProvider` on `--llm=openai|grok`) is a single inline `if/else` branch, not exported or shared. **Correction from round-1 review**: this doesn't mean there's no shared LLM abstraction anywhere in `e3d` — `buildDB/storyAgentLLM.js` is a genuinely shared helper supporting OpenAI/XAI/local providers, used elsewhere in the story pipeline, though it dispatches via process-global branching rather than a config-driven registry like `e3d-corp`'s `lib/llm/registry.js` (§3.7). It's a real, if less clean, precedent — worth checking before assuming any new provider-abstraction work in `e3d` starts from zero.

### 3.3 E3D hub notification infra

`server/macro/notifications.js` (`queueMacroStatusNotification`, `buildMacroStatusTransitionPayload`) plus `server/macro/emailNotifier.js` (`createEmailNotifier`, SES-backed via `nodemailer`) is genuinely reusable: the payload passed to `notifier.deliver(...)` is not macro-template-specific, so a new event type can build its own payload and call `queueMacroStatusNotification` directly. Two real caveats: `createEmailNotifier` sends to a single hardcoded owner address (`MACRO_NOTIFY_EMAIL`, default `spacepacket@gmail.com`) — it's an owner-alert mechanism, not subscriber fan-out — and `repository.js`'s `writeMacroSubjectRecord` only fires a notification if a `notifier` instance is explicitly passed in, which nothing in `buildMacroSignals.js`, `spacepacket.js`, or `macroRoutes.js` currently does. The hook is built and tested but not currently wired to send anything live from any code path we found — **caveat, per round-1 review: absence of a live send can't be proven from source alone**, only that nothing in the code we read constructs and wires a real notifier. Worth a direct question to Chris (or a mail-log check) rather than treating "never sent" as settled fact.

### 3.4 E3D hub existing webhook/idempotency precedent

No generic webhook abstraction exists, but there's a solid pattern to mirror: `server/stripePayments.js`'s `handleWebhook` verifies via `stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)`, and `spacepacket.js` explicitly excludes each webhook route's `originalUrl` from JSON body-parsing middleware so the raw body survives intact — any new webhook route needs a matching exclusion entry. Idempotency for Stripe is an **in-memory TTL** `claimOnce` store (`createStripeClaimStore`) keyed by session ID — not durable, would not survive a process restart. There's also a working outreach webhook (`projectOutreachRoutes.js`, path-secret-authenticated `/api/outreach/webhooks/ses-sns/:secret`) as a second structural reference.

### 3.5 E3D Macro & Liquidity Intelligence Pack (built earlier this session — directly relevant precedent)

This is the closest existing analog to the entire product being spec'd here: evidence → live-provider signals → versioned template (`templateRegistry.js`) → deterministic evaluator (`cryptoCapitalRotationEvaluator.js` / `evaluateTemplateWithTelemetry`) → verdict (status/confidence/`scoreExplanation`) → ClickHouse-backed persistence (`E3DMacroSignals`, `E3DMacroTheses`, `E3DMacroVerdicts`, `E3DMacroEvidence`) → hybrid console repository → notification hook. It's live today: the `liquidity-regime-shift` thesis template ingests real FRED/Coinbase data daily and serves a card at `e3d.ai/macro-intelligence`. Two hard-won lessons from that build directly apply here (see §18): ClickHouse's `DateTime64` JSONEachRow output has no timezone marker and misparses under a non-UTC host TZ unless normalized on read, and `date_time_input_format: 'best_effort'` is required on the client for ISO-8601 writes with a trailing `Z`.

### 3.6 E3D mobile push — real, but weaker and mislocated relative to draft v1's claim

**Correction from round-1 review**: `server/mobilePushRoutes.js` and `sendExpoPushMessages()` live in **`e3d`** (the hub's own server, confirmed at `server/mobilePushRoutes.js:248`, registered in `server/spacepacket.js`), not in `e3d-mobile` as draft v1 stated — `e3d-mobile` is the Expo/React Native *client* only (`expo-notifications`, wired through `src/features/notifications/{model,runtime,expoRuntime,context}`, with tests). The send path is real and production-wired. But it's narrower than "topic-subscribed" implies: subscriptions are **fixed boolean categories plus watchlist addresses** (`server/models/MobilePushSubscription.js`), not a generic topic system a new product can just register into by picking a topic string — adding a `'financial-stress'` channel means a real schema/UI change on both the `e3d` server and the `e3d-mobile` client, not a config addition. It also has no Expo delivery-receipt reconciliation. Usable, but "mature" overstates it — see §14 for the resulting V0 scoping decision (push dropped from V0).

### 3.7 `e3d-corp` reusable primitives (the biggest surprise of this audit)

`e3d-corp` (this repo) is a company-agnostic, event-sourced runtime built on seven durable primitives — Event → Opportunity → Proposal → Decision → Action → Outcome → Experience — with a versioned authority-level policy gating anything consequential behind a logged human Decision. Three pieces of it map almost exactly onto what this product needs:

- **`lib/llm/registry.js`** — `resolveProvider(instanceConfig, providerName)` returns `{ model, call({systemPrompt, userPrompt}) }` for any provider of kind `local`, `openai-compatible`, or `grok-cli`, entirely config-driven via `instanceConfig.llm.providers[name]`, with `resolveProviderStatus`/`listProviderStatuses` readiness checks. Nothing in it references opportunities, prospects, or any business-domain concept. `lib/llm/budget.js` implements a daily per-provider token ceiling (`RESERVED_TOKENS_BY_PROVIDER_KIND`, `reserveBudget`/`settleReservation`) entirely via event-sourced reserve/settle records. Both are directly importable as-is.
- **`lib/research/webSearch.js`** — `webSearch(query, {provider, apiKey})` POSTs to whatever URL is configured at `instanceConfig.research.webSearchProvider`, returning a structured `unavailableResult(...)` shape (`status: 'unavailable'`) rather than throwing when unconfigured/degraded. `lib/research/adapter.js`'s `createResearchAdapter` wraps this plus the knowledge-base MCP client, appending an `evidence.gathered` event per call. It is not wired to a specific search vendor — pointing it at Treasury/Fed queries needs zero code change.
- **`lib/authority/policy.js`** — `AUTHORITY_LEVELS` (0 observe, 1 internal write, 2 external/reversible, 3 financial, 4 irreversible), a versioned `ACTION_POLICY` map (`ACTION_POLICY_VERSION = 2` today) from action `type` string to required level, and `getRequiredAuthorityLevel`/`assertProposalAuthorized`. Adding a new action type is a one-line addition to this map, not new infrastructure. `lib/decisions/decide.js` (`decideProposal`, `confirmAndExecute`) and `lib/proposals/store.js`/`lib/proposals/create.js` are the generic Proposal/Decision machinery. Crucially, there is already a **working precedent for a second domain engine reusing this exact spine**: `lib/opportunities/investingEngine.js` + `investingSchema.js` were added alongside the original `engine.js`/`schema.js` for the recent e3d-corp↔e3d-trade capital-governance work, and `schema.js`'s validation only requires `candidate.type` be a non-empty string — it isn't hard-baked to sales/business language.
- **Cross-repo call precedent**: the most recent commit in this repo adds a capital-governance layer between `e3d-corp` and `e3d-trade` — a real, working example of "this repo decides and gates, then calls another repo's live API to execute." That is structurally the exact shape needed here (§4).

The one genuine gap, confirmed by direct investigation: **nothing in this repo, or any repo audited, implements "one canonical event fans out to a dashboard + notification + newsletter."** That's real new work regardless of which repo owns it.

### 3.8 OpenAI Responses API — background mode & webhooks (verified live, 2026)

Background mode (`background: true`) lets a Responses API call run asynchronously; you poll or receive a webhook. Webhook events for background responses: `response.completed`, `response.failed`, `response.cancelled`, `response.incomplete`. Signature verification follows the Standard Webhooks spec: `webhook-id`, `webhook-timestamp`, `webhook-signature` headers, verified via the OpenAI SDK's `unwrap()` or any Standard Webhooks library. Delivery retries for up to 72 hours with exponential backoff on non-2xx; **duplicate delivery is possible and `webhook-id` is the documented idempotency key** — this must be a durable store, not the in-memory TTL pattern Stripe currently uses in `e3d` (§3.4), given the 72-hour retry window.

The **deep research models** (`o3-deep-research`, `o4-mini-deep-research`) are the right tool for the research step: they orchestrate multi-step, multi-source investigation (web search, code interpreter, file search, remote MCP) into one synthesized report with inline citations, fully support background mode + webhooks, and expose `max_tool_calls` for cost/latency control. Runs take "tens of minutes," which is exactly why background mode + webhook (not a synchronous call) is the right shape. Background-mode data retention (~10 minutes) is incompatible with Zero Data Retention — not a concern for this product, but worth recording as a constraint if that ever matters elsewhere in the ecosystem.

### 3.9 ChatGPT's existing consumer monitor — confirmed no automation bridge

Investigated directly: ChatGPT's consumer **Scheduled Tasks feature explicitly cannot host Custom GPT Actions** ("voice, file uploads, and Custom GPTs are not available inside scheduled tasks" — OpenAI's own docs). If Chris's existing monitor is a Custom GPT (consistent with how tailored its behavior sounds), it cannot run as a scheduled/automated task at all, which is almost certainly why he triggers and reads it manually today. A separate, newer Connectors/Apps mechanism can sometimes run inside scheduled tasks, but any action that writes external data requires human approval on each run — no clean, fully automated bridge exists from the existing manual workflow to a webhook we control. **This confirms the original brief's instinct was correct**: V0 must rebuild the research+scoring via the Responses API rather than tap the existing ChatGPT monitor, using that monitor's demonstrated behavior as the quality bar to match, not as a component to integrate.

---

## 4. Brand & Repo Architecture Decision

The original brief's hypothesis — FutCo.ai owns the product surface and new orchestration, E3D provides intelligence plumbing — doesn't survive contact with what actually exists (§3.1, §3.7). **Draft v1 of this spec then proposed putting the entire running pipeline inside `e3d-corp`; round-1 review correctly flagged that as unsound** — `e3d-corp`'s durable state is a local JSONL event log (`lib/events/store.js`), which is a fine substrate for a human-paced CLI/web decision tool but a weak one for hosting live webhook receipt, an async multi-stage job, and the system of record for a public product's history. `e3d`'s ClickHouse-backed storage and real production server (already proven by the Macro & Liquidity Pack, §3.5) is the durable substrate this actually needs.

The corrected split:

| Layer | Home | Why |
|---|---|---|
| **Pipeline orchestration, canonical event storage, dashboard API, notification delivery, newsletter fan-out** | `e3d` (e3d.ai) | Owns the Stage 1 OpenAI call and webhook receipt, runs Stages 2/3 as an async worker (§9), and is system of record for every `FinancialStressChangeEvent` in durable ClickHouse. Reuses the Macro & Liquidity Pack's schema/evaluator/repository conventions and the real `queueMacroStatusNotification`/SES path. |
| **Human-approval gate** | `e3d-corp` | Keeps the one role round-1 review confirmed it's genuinely good at: a logged, versioned, human-in-the-loop Decision in front of anything consequential (§3.7's authority-level machinery). Receives a completed three-stage evaluation from `e3d` and turns it into a Proposal for Chris to review — it is not where the job runs, it's where the go/no-go decision is recorded. |
| **Research/evidence library code** | Shared, hosted where it runs (`e3d`) | `e3d-corp`'s `lib/llm/` and `lib/research/` modules (§3.7) are reused as *code* — either published as a small internal package or copied into `e3d`'s server — not as a remotely-hosted service `e3d` calls into. The job needs to run where its state lives. |
| **Public marketing/product page** | `applied.futco.ai` (`e3d-applied`) | A product page fetching from a new `e3d.ai` API endpoint, following the same pattern `e3d-applied` already uses for the AI Opportunity Scanner (§3.1) — real precedent now, not a stretch. |

**Cross-repo integration, reversed from draft v1's direction**: `e3d` completes a three-stage evaluation, then calls into `e3d-corp` to create a Proposal (rather than `e3d-corp` running the pipeline and calling out on completion). On Chris's approval, `e3d-corp`'s Action executor calls *back* to `e3d` with a signed "release" request that flips the event to published and triggers the fan-out — modeled on `lib/trade/client.js`'s existing pattern in this repo (explicit idempotency, retries, acknowledgment validation), which round-1 review pointed to as the right precedent to follow, not the looser shape draft v1 used. **Open question, flagged honestly rather than assumed**: does `e3d-corp` currently expose any authenticated HTTP intake surface at all (its README describes a CLI and a web UI, but this spec hasn't directly verified whether either is reachable as an API from another service), or does "create a Proposal from an external event" need to go through a small new local listener/cron consumer instead? Resolve this before finalizing the `e3d-corp` phase's tickets — see §27.

This keeps the "no direct runtime imports" ecosystem rule intact (§3.5's precedent, quoted from `e3d-maps`' architecture doc and treated ecosystem-wide): `e3d` and `e3d-corp` integrate over authenticated API calls in both directions, never a code import.

**Branding, unchanged from Chris's own framing**: *"U.S. Financial Stress Monitor — a FutCo intelligence product, powered by E3D."* Now more literally accurate than draft v1's version of it: `e3d` powers the actual running intelligence; `e3d-corp` is FutCo's own governance layer sitting in front of it before anything goes public.

---

## 5. Target Users & User Journeys

- **V0 primary user: Chris.** The system needs to match or exceed the trust he places in his current manual ChatGPT workflow before it's worth showing anyone else.
- **V1+: FutCo newsletter subscribers and dashboard visitors** — same audience the existing E3D/FutCo newsletter and site already reach.

Journeys:
1. **Glance** — dashboard visitor understands current stress regime in under 10 seconds (score, arrow, regime label, one-line summary).
2. **Alert** — subscriber gets a push/email only on material change, clicks through to the dashboard/newsletter for full context.
3. **Deep read** — newsletter subscriber gets the full before/after/why/implications narrative on their own schedule, not a stream of daily noise.

---

## 6. Financial Stress Score Model

**Recommendation: keep a 1–10 primary score for V0**, matching the existing ChatGPT prototype's output shape — this preserves direct comparability against the reference Chris already trusts during the transition, and re-deriving a 0–100 index or probability framing later is a display-layer transform, not a re-architecture, *as long as the underlying event schema stores enough raw structure to reproject* (§10, §20). Don't adopt a formal categorical state machine in V0 — regime labels ("Normal," "Elevated," "Danger Zone," etc.) can be derived from the two scores below via a small versioned threshold table in config, which is far cheaper than a state-machine class and just as auditable.

**Recommendation: adopt the two-axis model (Financial Stress Score + Liquidity Response Score).** This is the single most differentiated part of the product idea — the four-regime interpretation (low/low = normal, high/low = danger zone, high/rising = intervention underway, falling/high = bullish-asset regime) is exactly the kind of nuance a raw stress number alone can't convey, and it costs almost nothing to add: it's one more AI-produced number plus rationale in the same structured-output call, not a second research pass.

---

## 7. Signal Taxonomy & MVP Signal Set

The full taxonomy in the original brief (Treasury curve/auctions/depth, SOFR/repo/SRF, Fed balance sheet/QT/emergency facilities, Treasury buybacks/TGA, cross-market confirmation, stablecoin/T-bill flywheel) is the right **eventual** taxonomy, but **none of it should be built as deterministic ClickHouse ingestion in V0.**

Reasoning: V0's entire signal-gathering mechanism is the deep-research model's own live web browsing during each evaluation (§8) — that's what "do not immediately replace the ChatGPT workflow with an arbitrary deterministic formula" means in practice. The "signals" in V0 are evidence citations inside the AI's structured output, not rows in a table populated by a separate ingestion pipeline. Building deterministic quant ingestion (2Y/5Y/10Y/30Y yields, SOFR, auction tails, etc.) is explicitly V1 work (§23), once there's enough V0 history to know which of these actually move the AI's judgment.

One complementary note worth designing for now: the Macro & Liquidity Pack's `liquidity-regime-shift` thesis (§3.5) *already* ingests some of this deterministic data live via `ratesLiveProvider.js` — 2Y and 10Y Treasury yields, a broad-dollar proxy, and the HY OAS credit spread. **Revised per round-1 review**: rather than fully excluding this from V0, hand it to Stage 1 as **structured context** in the research prompt (e.g. "here are today's live 2Y/10Y/dollar-proxy/HY-OAS readings from our own existing macro engine") — it's already live, already free to read, and gives the deep-research model a grounded numeric anchor instead of relying entirely on whatever it finds via web search. This is explicitly *not* deterministic scoring input (the AI still forms its own judgment) — that distinction, and the full deterministic-ingestion buildout, stays V1 work (§23).

One factual correction from round-1 review: the dollar-proxy series behind `ratesLiveProvider.js` is FRED's broad trade-weighted dollar index (`DTWEXBGS`), not the literal ICE DXY index the original brief and dashboard copy should be careful not to conflate — DTWEXBGS is a reasonable dollar-strength proxy but a different, broader basket than DXY. Label it correctly wherever it surfaces (§13's dashboard, §15's newsletter).

V1's quant layer should pull from the existing `liquidity-regime-shift` system rather than duplicate ingestion where the two overlap — see §16.

---

## 8. AI Scoring Architecture — Multi-Model Collaboration Pipeline

Chris's own framing: *"ideally, all of our AI's could collaborate."* Rather than a single model doing research, scoring, and narrative in one call: **a three-stage pipeline across three different providers, each doing the part it's actually best positioned for**, with every stage's output — including any disagreement between models — preserved in the canonical event rather than silently collapsed into one number. **Orchestration lives in `e3d`** (§4, §9), not `e3d-corp` — this section describes what each stage does, not where the code that drives them runs.

This isn't new infrastructure so much as new *orchestration* of infrastructure this spec already commits to reusing: `e3d-corp`'s `lib/llm/registry.js` already models "many interchangeable providers behind one call shape" (§3.7), and `codex-spec-runner` is already a working, proven precedent in this exact ecosystem for routing a workflow across "Codex CLI or Claude CLI" — treating "different AIs handle different stages" as normal, not exotic.

### 8.1 Stage 1 — Research & Score Proposal (OpenAI deep-research)

Unchanged from the original design: `o3-deep-research` or `o4-mini-deep-research` via the Responses API, `background: true`, `max_tool_calls` capped for cost/latency control. This is the only stage that does live, multi-source web research — chosen because it's the only one of the three with a purpose-built, tool-orchestrating deep-research mode (§3.8). Output: a draft `score_after`, `liquidity_response_after`, `drivers[]`, `evidence[]` (with citations), and `material_change` determination, plus the FRED-sourced context described in §7.

### 8.2 Stage 2 — Inference Critic (Grok), with a real escalation path

**Reframed per round-1 review**: reviewing Stage 1's own evidence bundle is a genuine check on Stage 1's *reasoning* (does the evidence actually support the conclusion? is anything overweighted?), but it cannot catch what Stage 1's research simply never found — it is an inference critic, not independent research, and this spec no longer calls it that. Grok receives the Stage 1 evidence bundle (citations, drivers, raw research findings) but **not** Stage 1's score, to avoid anchoring: it independently derives its own `score_after`/`liquidity_response_after` from the same evidence, and separately flags anything it thinks the evidence doesn't support or is missing. Wired through the existing `grok-cli` kind in `lib/llm/registry.js` — no new provider plumbing needed.

**V0 escalation path, added per round-1 review's suggested alternative**: if Stage 2's score diverges from Stage 1's by more than the configured threshold (§8.4, §27), or if Stage 2 itself flags that key evidence looks thin, that triggers a real **Stage 2b independent retrieval** — Grok runs its own live search on the specific disputed point(s) only (not a full re-research pass), rather than only ever re-reading Stage 1's citations. This is cheap relative to a full independent deep-research run (targeted, not comprehensive) and directly answers round-1 review's concern that shared-evidence-only review risks being theater. Routine, low-disagreement evaluations never trigger it — only genuine disputes do.

### 8.3 Stage 3 — Narrative Synthesis (Claude)

Triggered after Stage 2 (and Stage 2b, if it ran) returns. Given both independent scores, the evidence, and any disagreement, Claude writes the actual prose: the notification blurb, the newsletter narrative, and the dashboard summary line. **Selection criterion, corrected per round-1 review**: Claude is proposed here because narrative-writing that must clearly explain a disagreement between two other models' judgments is a writing task suited to a strong long-form writer — not because Claude authored this spec, which isn't selection evidence. This should be validated during implementation by benchmarking narrative fidelity against Chris's existing manual ChatGPT workflow (§3.9) before treating the choice as settled. Wired through a new `claude-cli` provider kind in `lib/llm/registry.js` (or wherever the registry pattern ends up living per §4), mirroring `codex-spec-runner`'s already-working "Claude CLI" invocation pattern. **Worth considering for short-form channels**: a deterministic template (fill-in-the-blanks from the structured event) for the push/email alert text, reserving the LLM-written narrative for the newsletter and dashboard summary — cheaper, faster, and removes one more LLM call from the critical path for the most time-sensitive channel.

### 8.4 Disagreement handling

If Stage 1 and Stage 2's scores diverge by more than a configured threshold (§27), that's **never silently averaged or resolved by code**. Both scores, the delta, and Stage 3's plain-language explanation of the disagreement all ride along in the canonical event (§10). **Revised per round-1 review to avoid reviewer fatigue**: routine, small disagreements are summarized into a single triage line on the Proposal ("Stage 1/2 agreed within threshold" or "diverged by X, see detail") with full per-stage detail available on expand, not dumped in full on every single evaluation. Only evaluations with a real, above-threshold disagreement (or a Stage 2b escalation) surface the full comparison by default.

### 8.5 Degraded-stage handling

If **Stage 2** fails or times out, the pipeline does **not** block — it proceeds with Stage 1 only and marks Stage 2 `degraded` in the event, mirroring `lib/research/webSearch.js`'s existing "record degraded, don't silently skip" convention (§3.7). **Revised per round-1 review**: if **Stage 3** fails, the pipeline must *not* auto-publish anything — an evaluation with unfinished or missing narrative text should never reach a public channel. It still reaches human review (Chris can approve using the raw Stage 1/2 scores and evidence, or wait/retry Stage 3), but each publish channel (dashboard, notification, newsletter) needs its own explicit policy for what "degraded narrative" means for that channel — e.g. the dashboard can show raw scores without prose, but an email/push alert without real narrative text probably shouldn't send at all. This per-channel policy is a concrete open item for ticket-writing (§27), not resolved further in this doc.

**Prompt/methodology versioning**: every stage's literal prompt text and a `promptVersion` tag are stored with every run (§20) — required for the audit trail and for reproducing/debugging any given evaluation later.

---

## 9. Webhook Architecture

**Revised per round-1 review**: the original design ran Stage 2 and Stage 3 synchronously inside the OpenAI webhook handler. That's the wrong shape — OpenAI expects a fast 2xx acknowledgment, and blocking on two more LLM calls (plus a possible Stage 2b escalation) inside that handler risks timeout-driven retries and duplicate processing. New route lives **in `e3d`** (§4 — this is where the pipeline is hosted, not `e3d-corp`), receiving `response.completed`:

1. Verify the Standard Webhooks signature (`webhook-id`/`webhook-timestamp`/`webhook-signature`) against the raw body, mirroring `e3d`'s Stripe-webhook raw-body-passthrough pattern (§3.4) — the framework's body-parser must exclude this route's path.
2. **Verify → durably claim → immediate 2xx.** Deduplicate on `webhook-id` against a durable idempotency store (a new ClickHouse table, not the in-memory TTL pattern Stripe uses today, since OpenAI's retry window is 72 hours and a process restart must not cause duplicate work), write a claimed/pending row, and return 2xx immediately — before Stage 2/3 run at all.
3. A separate async worker (polling the pending-work table, or a queue if one already exists in `e3d` — check before adding a new one) picks up the claimed row, calls `client.responses.retrieve(response_id)` to fetch Stage 1's full structured output, then runs Stage 2 (and Stage 2b if triggered, §8.2) and Stage 3 (§8.3) — all outside the webhook request/response cycle.
4. Once all stages resolve (or degrade per §8.5), the worker calls into `e3d-corp` to create a Proposal (§4, §12) — this is a new outbound call *from* `e3d`, reversing draft v1's direction.

**Run lifecycle and idempotency, added per round-1 review** (previously unspecified): each evaluation cycle gets its own `run_id`, generated when Stage 1 is kicked off, distinct from OpenAI's `response_id`/`webhook-id`. Overlap prevention — a new evaluation cycle should not start while a prior one for the same product is still pending Stage 2/3 or awaiting human review; the scheduler checks for an open `run_id` before starting a new one. `score_before`/`regime_before` (§10) are read from the most recent **approved and published** event, not the most recent evaluation attempt, so an in-flight or rejected run never becomes the baseline for the next one. Out-of-order or stale webhook deliveries (e.g. a very late retry for an already-superseded `run_id`) are detected and discarded, not reprocessed. A periodic reconciliation poll against OpenAI's own response-status endpoint is the backstop for a webhook that never arrives at all.

---

## 10. Canonical `FinancialStressChangeEvent`

Adapted from the original brief's schema to carry all three pipeline stages (§8) explicitly — never collapsed into one silently-reconciled number:

```json
{
  "event_id": "...",
  "run_id": "...",
  "timestamp": "...",
  "score_model_version": "1.0.0",

  "score_before": 7.4,
  "score_after": 8.2,
  "liquidity_response_before": 2.0,
  "liquidity_response_after": 2.3,
  "regime_before": "...",
  "regime_after": "...",
  "material_change": true,

  "review_status": "pending",
  "final_score": null,
  "final_liquidity_response": null,
  "final_regime": null,
  "reviewer_correction_note": null,

  "pipeline": {
    "stage1_research": {
      "provider": "openai-deep-research",
      "model": "o3-deep-research",
      "prompt_version": "1.0.0",
      "status": "ok",
      "score_after": 8.2,
      "liquidity_response_after": 2.3,
      "drivers": [],
      "evidence": []
    },
    "stage2_crosscheck": {
      "provider": "grok",
      "prompt_version": "1.0.0",
      "status": "ok",
      "score_after": 7.6,
      "liquidity_response_after": 2.1,
      "agreement_delta": 0.6,
      "flags": []
    },
    "stage3_narrative": {
      "provider": "claude",
      "prompt_version": "1.0.0",
      "status": "ok",
      "disagreement_explanation": "..."
    }
  },

  "drivers": [],
  "counter_signals": [],
  "evidence": [],

  "treasury_state": {},
  "funding_state": {},
  "fed_state": {},
  "treasury_policy_state": {},
  "market_confirmation": {},

  "near_term_bias": "...",
  "medium_term_bias": "...",
  "btc": {}, "eth": {}, "xrp": {}, "xlm": {},

  "next_triggers": [],
  "notification": {},
  "newsletter": {}
}
```

**Resolved per round-1 review** ("resolve duplicated authoritative fields... top-level ownership silently privileges Stage 1"): the top-level `score_after`/`liquidity_response_after` are explicitly Stage 1's *draft* numbers, used only as the working value while a Proposal is `pending` — they are never the number a public surface renders. `final_score`/`final_liquidity_response`/`final_regime` are `null` until Chris's Decision, at which point they're set from whatever he actually approved — which may equal Stage 1's number, Stage 2's, a blend, or a manually corrected value he enters directly (`reviewer_correction_note` records why, if he overrides either stage). Every public surface (§13, §14, §15) reads `final_*` fields only, never the pipeline drafts. `review_status` moves `pending → approved | rejected | corrected`. Stage 2's independent numbers and the delta live in `pipeline.stage2_crosscheck`, always present, never discarded, regardless of what the final approved value ends up being. Any stage's `status` can be `"ok"` or `"degraded"` (§8.5).

`score_model_version` tracks the scoring *methodology* (the V0→V3 evolution in §23); each stage's own `prompt_version` tracks that stage's literal prompt text independently, since Stage 1, 2, and 3 prompts will each evolve on their own schedule.

The dashboard, notification, newsletter, and any future API all read from this one event — never independently regenerated.

---

## 11. Material-Change Detection

The AI itself determines `material_change` as part of its structured output — matching the existing ChatGPT prototype's actual behavior, not a separate deterministic diff algorithm. **Every** evaluation is stored regardless of the flag (§18); `material_change` only gates whether a Proposal requiring human review gets created (§12) versus an autonomous, ungated internal record.

---

## 12. Human Review Workflow

Maps onto `e3d-corp`'s existing primitives (§3.7), with one correction from round-1 review:

- A `material_change: false` evaluation is authority level 0/1 (observe/internal write) — stored automatically, no Proposal, matching the existing rule that levels 0–1 never generate one.
- A `material_change: true` evaluation becomes a **Proposal** of a new type, e.g. `publish-stress-change`. **Corrected authority level**: draft v1 put this at `AUTHORITY_LEVELS.EXTERNAL_ACTION` (2), matching `send-outreach`'s "approve and execute in the same call." Round-1 review caught that this is wrong by `e3d-corp`'s own existing policy: email/push/newsletter sends cannot be recalled once fired, and `lib/authority/policy.js` already classifies exactly this kind of irreversible public announcement at `AUTHORITY_LEVELS.IRREVERSIBLE_ACTION` (4) — same tier as `mark-deal-closed`. This spec now follows that existing classification: approval and execution are **two separate explicit steps** (`decideProposal` then a distinct `confirmAndExecute` call), not one. `ACTION_POLICY_VERSION` increments.
- The Proposal Chris reviews shows a triage summary by default (§8.4) with the full three-stage pipeline detail available on expand: Stage 1's score and evidence, Stage 2's independent score and any flags, the agreement delta, and Stage 3's narrative.
- **Reviewer correction, added per round-1 review** ("not only approve/reject"): the review action isn't limited to binary approve/reject. Chris can also correct the score/regime before approving (writing to `reviewer_correction_note` and the `final_*` fields, §10) — e.g. siding with Stage 2 over Stage 1, or adjusting either. Nothing about how to weigh a disagreement is decided by code; it's presented, and Chris decides, with the option to actually change the number, not just accept or block it.
- Chris approves via `decideProposal`, then separately `confirmAndExecute` (matching level-4's two-step requirement). The confirmed Action calls back into `e3d` (§4, §9) with the approved `final_*` values.
- **This human-gated flow is a deliberate, explicit MVP choice, not a permanent one**: automate later, once false-positive rate and scoring consistency are proven out (matches the original brief's own instruction).

---

## 13. FutCo Dashboard

Served by `e3d.ai`, presented under FutCo branding at `applied.futco.ai`. **Decided, not left open**: a thin server component on `e3d-applied` fetching from a new `e3d.ai` API endpoint (CORS-enabled), rendered with FutCo's own design system — following the exact pattern `e3d-applied` already uses for the AI Opportunity Scanner's intake/status flow (§3.1), which resolves what was previously an open question in draft v1. A link-through to the fuller Macro-Pack-style console (mirroring `/macro-intelligence`, §3.5) on `e3d.ai` itself handles drill-down, rather than iframing it.

UX, per the original brief, unchanged: score + directional arrow, regime, 3–5 word summary, top 3–5 drivers, drill-down into the underlying state buckets, and a prominent "what would move the score next" — understandable in under 10 seconds.

---

## 14. Notifications

- **Email**: reuse `queueMacroStatusNotification`/`emailNotifier.js` (§3.3) as the delivery mechanism, but it must be extended from single-hardcoded-recipient to real subscriber fan-out — genuinely new work, not a reuse. **Consent, added per round-1 review** ("existing newsletter consent does not imply stress-alert consent"): a new, distinct opt-in field on the existing Mongo `User` model (e.g. `subscribeFinancialStressAlerts`), never inferred from `subscribeNewsletter`, with its own unsubscribe link/flow — not bundled with the daily newsletter's consent. Fix the `username`-vs-`email` bug (§3.2) while touching adjacent code.
- **Push: dropped from V0**, per round-1 review's finding that the real subscription model is fixed boolean categories plus watchlists, not generic topics (§3.6) — adding a `'financial-stress'` channel needs real schema/UI work on both `e3d`'s server and the `e3d-mobile` client, which this spec doesn't currently scope as its own ticket set. Either write that as an explicit fourth-repo addendum before V0 ships, or treat push as a V1 addition once V0's email/dashboard path is proven. This spec assumes the latter.
- **First real production use of `emailNotifier.js`**: worth flagging explicitly that no code path we found currently wires it to send anything live (§3.3) — treat its first real send as a mini-launch, not an assumed-working dependency, and confirm directly with Chris whether it's actually ever fired before assuming it's fully untested in production.

---

## 15. Newsletter

A new, event-triggered script, but **not** sharing `write_newsletter_v3.js`'s single "latest file" delivery mechanism (§3.2) — that would race the existing daily E3D newsletter. This requires the one genuinely new entity the audit found missing everywhere: a "newsletter issue," even if implemented minimally (its own output directory/table, not a shared "latest" pointer). **Corrected per round-1 review** ("do not regenerate newsletter prose after Stage 3; render the approved canonical narrative"): this script does **not** call an LLM to write fresh prose at send time. It renders the `final_*` fields and Stage 3's already-reviewed narrative text straight from the approved `FinancialStressChangeEvent` (§10) — the same text Chris already reviewed and approved, not a new generation that could drift from what was actually approved. Delivery reuses the existing Office365 SMTP `sendEmail` plumbing, subject to the separate opt-in from §14.

---

## 16. Macro & Liquidity Pack Integration

Implement the "these are complementary signals" relationship from the original brief as a **presentation-layer join, not a code coupling**: the dashboard reads both this product's latest `FinancialStressChangeEvent` *and* the existing `/api/macro-intelligence` `liquidity-regime-shift` card, and composes the two-axis interpretation (e.g. "Stress 8.5, Response 2.0, Liquidity Regime Shift unconfirmed → danger zone, policy still refusing to respond") at render time. This preserves the ecosystem's "no direct runtime imports" rule (§3.5) — the two evaluators never call into each other's code, only their already-public API surfaces.

---

## 17. Crypto/Regulatory Interpretation & Stablecoin/Treasury Module

Both deferred to V1+, consistent with the V0 signal-set decision in §7. The deep-research model's own web browsing will naturally surface regulatory news (CLARITY Act, GENIUS implementation, etc.) and can mention it qualitatively in V0's narrative without any dedicated structured ingestion — a dedicated overlay/module is real new work best justified once V0 history shows it's needed.

---

## 18. Evidence/Provenance & Historical Dataset

Every evaluation — material or not — is stored. New ClickHouse tables follow the Macro Pack's exact naming and typing conventions (`DateTime64(3, 'UTC')` for all timestamp columns), and **must** apply the same UTC-normalization fix built this session for that engine (§3.5): ClickHouse's JSONEachRow output for `DateTime64` has no zone marker and silently misparses under a non-UTC host timezone (e3d.ai runs `America/Los_Angeles`) unless normalized to explicit ISO-8601 UTC on read. This is a transferable lesson, not just transferable code — call it out explicitly in the ticket that builds this product's persistence layer so it isn't rediscovered the hard way twice.

Outcome tracking at 1h/1d/1w/1mo/3mo across Treasury yields, DXY, gold, Nasdaq, BTC, ETH, XRP — **XLM is a real gap**: neither the Macro Pack nor any audited repo has a Stellar/XLM price provider today. Either build one (small, Coinbase-style spot-price provider, mirroring `marketPriceLiveProvider.js`'s Coinbase pattern) or explicitly scope XLM out of V0's tracked-outcomes set and flag it as a known gap, not a silent omission.

---

## 19. Backtesting

A literal historical backtest (2008, 2011 debt ceiling, 2013 taper tantrum, 2019 repo crisis, March 2020, 2022 UK gilts, 2023 regional banks, 2025–26 Treasury stress) against the actual production system isn't possible for V0 — the model wasn't running then, and web-search-grounded research can't be rewound to what was known in real time without deliberately reconstructing period-accurate source sets, which is expensive. Recommend instead a **qualitative methodology backtest** as part of spec review (a research/writing exercise, not an engineering one): walk the scoring dimensions (Treasury stress, funding stress, Fed response, Treasury response, cross-market confirmation) against how each historical episode actually unfolded, and sanity-check that the *methodology* would have moved the right way, in roughly the right order, at each stage. A rigorous quantitative backtest becomes possible once V1's deterministic signal layer exists (§23).

---

## 20. Score-Versioning / Model & Prompt Versioning

Every stored event carries `score_model_version` plus, per pipeline stage (§8, §10), that stage's own provider/model name and `prompt_version` — mirroring the Macro Pack's `templateVersion`/`evaluatorVersion` pinning convention (its own prior spec's REQ-G10), which already exists as a proven pattern in this ecosystem for exactly this problem. A change to Stage 2's prompt shouldn't force a version bump on Stage 1 or Stage 3 — each stage's methodology evolves on its own clock.

---

## 21. API Design, Storage, Security, Idempotency, Observability, Failure Modes

- **Webhook verification & idempotency**: §9 — Standard Webhooks signature verification, durable claim-then-2xx, dedup on `webhook-id`, plus `run_id`/`event_id`-level idempotency (§9, §10) so the `e3d` → `e3d-corp` Proposal-creation call and the `e3d-corp` → `e3d` release call are each separately idempotent — a retried release call must not double-publish.
- **Storage**: `e3d.ai` ClickHouse, new tables mirroring `E3DMacro*` schema conventions (§18), plus a durable pending-work table for the async Stage 2/3 worker (§9).
- **Security, expanded per round-1 review** (item 6 — "HMAC timestamp/replay protection... prompt-injection defenses... payload limits"): both cross-repo calls (`e3d`→`e3d-corp` Proposal creation, `e3d-corp`→`e3d` release, §4) need their own signed-request scheme with a timestamp and replay window, mirroring `lib/trade/client.js`'s existing idempotency/retry/acknowledgment pattern rather than a bare shared secret. Request bodies need explicit size limits (a pathological deep-research response or malicious evidence payload shouldn't be able to blow up storage or downstream rendering). **Prompt-injection defense, new item**: Stage 1's web research reads real, uncontrolled internet content — the pipeline must treat retrieved page text as data, never as instructions, when it's fed into Stage 2/Stage 3 prompts, and Stage 3's output should be schema-validated (not just trusted free text) before it's allowed into a public-facing channel.
- **Citation freshness/claim mapping, new item**: each entry in `evidence[]` should carry a captured-at timestamp and a link back to the specific driver/claim it supports, not just a bare URL — needed both for the "why" a reader can inspect and for later backtesting work (§19) to know how stale a cited source was relative to the evaluation.
- **Observability**: reuse the Macro Pack's `observability.js`/`evaluateTemplateWithTelemetry` telemetry-logging pattern for the evaluation cycle; log webhook receipt, verification result, worker pickup, and Proposal creation as discrete, greppable events.
- **Failure modes to design for explicitly**: OpenAI webhook never arrives (reconciliation poll backstop, §9); deep-research call exceeds `max_tool_calls` or times out; Stage 2 fails/times out (proceeds degraded, §8.5); Stage 3 fails (does **not** auto-publish, §8.5 — per-channel policy); human never reviews a pending Proposal (needs a staleness indicator); a release call is retried after a partial publish (needs the idempotency above to avoid double-sending a notification or newsletter).
- **Data-quality risk**: the AI's own web research quality varies run to run — the `evidence[]` array with citations, Stage 2's inference-critic check plus Stage 2b escalation on real disagreement (§8.2, §8.4), and schema validation on Stage 3's output are the layered defenses, not a single hard quality gate.
- **Cost risk, specific to the multi-stage pipeline**: Stage 1 is the expensive/slow leg (tens of minutes, deep-research pricing); Stage 2 is cheap unless Stage 2b escalates; Stage 3 is cheap, or free if the short-alert channel uses a deterministic template (§8.3) instead of an LLM call. If evaluation cadence (§27) is set too aggressively, Stage 1 cost dominates.

---

## 22. Legal / Investment-Advice Considerations

Explicit, prominent "not investment advice" disclaimer required on the dashboard, every notification, and every newsletter issue — not boilerplate. The product makes directional calls on specific assets (BTC/ETH/XRP/XLM); this is a real requirement, not a formality, and should be drafted with the same care as `e3d-applied`'s existing "no fabricated claims" guardrail.

---

## 23. MVP / V1 / V2 / V3 / Future

- **V0**: AI (deep-research) does research + scoring; human reviews/approves every material-change Proposal before publish; every evaluation stored regardless.
- **V1**: AI scoring informed by real deterministic quantitative indicators — starting with what the Macro Pack's `liquidity-regime-shift` template already ingests live (§16) rather than duplicating ingestion, then expanding into the fuller Treasury/funding/Fed taxonomy from §7.
- **V2**: formal component scores + calibrated weights + AI synthesis on top of them.
- **V3**: statistically calibrated Financial Stress Index with AI-generated explanation layered on top, not driving the number.
- **Future**: institutional/API product surface, once the historical Stress→Response→Asset-reaction dataset (§18) is deep enough to be a real moat.

`score_model_version` (§20) makes every methodology transition auditable against the history it produced.

---

## 24. Monetization / Differentiation / Defensibility

The accumulating historical dataset — every evaluation, material or not, with outcomes tracked at five horizons across seven-plus assets/instruments — is the actual moat, per the original brief's own framing: nobody else has *this specific* AI's judgment calibrated against *this specific* history of Stress → Policy Response → Asset Reaction. The two-axis regime model (§6) is the most differentiated single feature versus a plain stress-score product.

---

## 25. Implementation Phases / Tickets

This spans three repos, which `codex-spec-runner` doesn't natively support in one run (it executes phases against a single working directory, `-C <dir>`, per invocation). **The three per-repo phased spec files now exist**, written directly against each repo's real code (route patterns, auth conventions, existing precedent) rather than as an abstract plan:

- `e3d/docs/us-financial-stress-monitor-e3d-spec.md` — `E3D-FSM-1xx`: event schema/storage, Stage 1 + webhook, Stages 2/2b/3 async worker, cross-repo integration, dashboard API/notifications/newsletter.
- `e3d-corp/docs/us-financial-stress-monitor-e3d-corp-spec.md` — `E3D-FSM-2xx`: webhook intake modeled directly on the existing `e3d-applied-lead`/`e3d-trade-outcomes` pattern, authority-policy/reviewer-correction, two-step approval and signed release call modeled on `lib/trade/client.js`.
- `e3d-applied/docs/us-financial-stress-monitor-e3d-applied-spec.md` — `E3D-FSM-3xx`: dashboard page modeled directly on the existing AI Opportunity Scanner page/content/API-route pattern.

**Dependency order, reversed per round-1 review** ("finalize contract, build `e3d` ingest/outbox first, then `e3d-corp`, then surfaces"): run as three separate `codex-spec-runner` invocations in this order — **`e3d`** first (its ingest contract is what the other two build against), then **`e3d-corp`** (needs `e3d`'s webhook contract stable), then **`e3d-applied`** (needs a real, approved-event-serving `e3d` API endpoint to point at).

Each per-repo file resolves its open questions locally where this session had enough evidence to do so (e.g. `e3d-corp`'s file confirms and cites the real existing `lib/web/server.js` webhook/auth pattern rather than treating it as unverified per §27.1) and calls out remaining Chris-only decisions (cadence, XLM sourcing, route path) explicitly rather than guessing.

---

## 26. Acceptance Criteria (draft, pending §27)

- A real Stage 1 deep-research call, end to end, produces a structured evaluation matching the schema in §10, processed by `e3d`'s async worker (§9), not inline in the webhook handler.
- Stage 2 (Grok) and Stage 3 (Claude) both run against a real Stage 1 output and populate `pipeline.stage2_crosscheck`/`pipeline.stage3_narrative` — including at least one deliberately-forced disagreement above threshold during testing, to prove the delta/flag/explanation path actually surfaces (§8.4) and that it correctly triggers a Stage 2b escalation (§8.2) rather than silently averaging.
- Killing Stage 2 mid-pipeline still produces a complete, human-reviewable Proposal with that stage marked `degraded`. Killing Stage 3 does **not** produce a publishable event on any channel until either Stage 3 succeeds on retry or Chris explicitly proceeds without narrative on a channel whose per-channel policy (§8.5) allows that.
- A `material_change: true` evaluation results in `e3d` calling into `e3d-corp` to create a real Proposal at authority level 4, visible via the existing CLI/web Decision surfaces, showing the triage summary and full three-stage detail on expand.
- Chris can correct the score before approving (§12) and the correction is reflected in `final_*` fields, not just the original stage drafts.
- Approving requires **two separate steps** (`decideProposal` then `confirmAndExecute`, §12) — a single approval call does not publish anything.
- Confirming results in a signed release call back to `e3d`, a real `FinancialStressChangeEvent` row in `e3d.ai` ClickHouse with `review_status: "approved"` and populated `final_*` fields, a real dashboard update reading only `final_*`, a real email notification to genuinely opted-in subscribers (§14), and a real newsletter issue rendering the already-approved narrative verbatim (§15) — not regenerated.
- A `material_change: false` evaluation is stored but produces no Proposal, no notification, no newsletter.
- Webhook replay (same `webhook-id` delivered twice) produces exactly one claimed work item, not two. A retried release call from `e3d-corp` to `e3d` does not double-publish.

---

## 27. Open Questions / Explicit Assumptions

Resolved in this revision (previously open in draft v1): dashboard presentation approach (§13, decided: thin `e3d-applied` component), push notifications (§14, decided: dropped from V0), Stage 2 escalation path (§8.2, decided: targeted Stage 2b retrieval on disagreement, added to V0), authority level for publish (§12, decided: 4, not 2).

**Resolved while writing the per-repo specs** (§25): `e3d-corp` does expose an authenticated HTTP intake surface today — `lib/web/server.js` already has two working webhook routes (`/webhooks/e3d-applied-lead`, `/webhooks/e3d-trade-outcomes`), both bearer-token authenticated via `lib/web/auth.js`. The `e3d-corp` per-repo spec adds a third, `/webhooks/financial-stress-evaluation`, following that exact existing pattern rather than inventing a queue-based alternative. Cross-repo signed-request specifics (previously open item 3) are also resolved there: inbound reuses the existing bearer-token webhook pattern; outbound (the release call) is modeled directly on `lib/trade/client.js`'s existing header-auth/retry/timeout shape, not a new scheme.

Still open:

1. **XLM price sourcing** — build a provider or scope out of V0 (§18); the `e3d` per-repo spec recommends dropping it from V0's tracked-asset set, pending Chris's confirmation.
2. **Per-channel degraded-narrative policy** (§8.5) — which channels can publish with Stage 1/2 data only and no Stage 3 prose (dashboard: probably yes) versus which should never send without real narrative (email/newsletter: probably no) isn't finalized.
3. **Newsletter issue entity's minimum shape** — this spec deliberately doesn't over-design it (§15); needs just enough schema to avoid colliding with the daily E3D newsletter, decided during ticket-writing.
4. **Assumption**: Chris will remain the sole human reviewer for V0 — no multi-reviewer/approval-queue UX is in scope.
5. **Assumption**: `o3-deep-research`/`o4-mini-deep-research` pricing and "tens of minutes" latency are acceptable for a roughly-hourly-or-less-frequent evaluation cadence; exact cadence is not yet decided and should be set based on cost, not just news-cycle speed. The `e3d` per-repo spec ships a default (every 6 hours, configurable) as a starting point, not a considered final answer.
6. **Disagreement threshold** — the numeric delta between Stage 1 and Stage 2 scores that triggers Stage 2b escalation and full-detail surfacing (§8.2, §8.4) isn't set; the `e3d` per-repo spec ships a default of ≥1.0 on the 1–10 scale, tune once there's real dual-model history.
7. **`claude-cli`/`openai-deep-research` provider kinds** — the `e3d` per-repo spec builds these as focused per-product clients rather than a full port of `e3d-corp`'s generic `lib/llm/registry.js`, matching its call shape for future consistency. Confirm this scoping is acceptable rather than wanting the fuller registry ported now.
8. **Deterministic short-alert template vs. LLM-written alert text** (§8.3) — worth prototyping both before committing, since it affects Stage 3's role and cost.

---

## 28. Build / Modify / Defer Recommendation

**Build** (order per §25): in `e3d` — the Stage 1 OpenAI deep-research + webhook integration with async worker (§9), Stages 2/2b/3 orchestration (§8), ClickHouse event/pending-work tables (§10, §18), dashboard API, event-triggered newsletter script rendering approved narrative only (§15). In `e3d-corp` — a Proposal-intake path from `e3d` plus the release Action calling back to `e3d` (§4, §12). In `e3d-applied` — the marketing/dashboard page fetching from `e3d`'s new API (§13).

**Modify**: fix the `user.username`-vs-`user.email` bug in `send_newsletter.js` while touching adjacent code (§3.2); wire up `emailNotifier.js` for its first real production use (§14), first confirming with Chris whether it already sends anything today; extend `ACTION_POLICY` with the new action type at level 4 (§12); extend `lib/llm/registry.js` (or its `e3d`-hosted equivalent, §4) with two new provider kinds — `openai-deep-research` (Stage 1) and `claude-cli` (Stage 3) — alongside the existing `grok-cli` (Stage 2).

**Defer to V1+**: full (non-targeted) independent Stage 2 research beyond the Stage 2b escalation now in V0 (§8.2); deterministic quantitative signal ingestion beyond what `liquidity-regime-shift` already provides as context (§7, §23); crypto/regulatory structured overlay and stablecoin/Treasury module (§17); formal quantitative backtesting (§19); formal categorical state machine for regime labeling (§6); automated (ungated) publishing (§12); push notifications, pending an `e3d-mobile` scoping pass (§14).

---

## 29. Revision Log

- v1 (2026-09-02): Initial draft, following direct investigation of `e3d-corp`, `e3d`, `e3d-applied`, `e3d-mobile`, and the OpenAI Responses API. Ready for round-1 multi-model review.
- v2 (2026-09-02): Replaced single-model scoring+narrative with a three-stage multi-AI collaboration pipeline (§8) per Chris's explicit request — OpenAI deep-research (Stage 1, research+score), Grok (Stage 2, independent shared-evidence cross-check), Claude (Stage 3, narrative synthesis and disagreement explanation). Canonical event schema (§10), human review workflow (§12), webhook architecture (§9), failure modes (§21), and open questions (§27) all updated to carry per-stage output and disagreement handling rather than one collapsed score.
- v3 (2026-09-02): Revised after round-1 review by `codex` and `grok` against the real repos. Corrected a stale factual claim (§3.1 — `e3d-applied` already runs a real live product, the AI Opportunity Scanner). Reversed the core architecture: `e3d` (durable ClickHouse + production server), not `e3d-corp` (local JSONL event store), now hosts the running pipeline and canonical event storage; `e3d-corp` narrows to the human-approval gate, reusing `e3d-corp`'s LLM/research code as library code rather than hosting the job (§4). Moved webhook processing from synchronous-inside-handler to verify→durably-claim→2xx→async-worker (§9). Corrected the publish action's authority level from 2 to 4, matching `e3d-corp`'s own existing policy for irreversible public announcements, and added a real reviewer-correction capability instead of binary approve/reject (§12). Resolved the duplicated-authoritative-fields issue with explicit `final_*` fields set only on approval (§10). Reframed Stage 2 as an inference critic and added a real, targeted Stage 2b escalation to independent retrieval on large disagreement (§8.2) rather than deferring all independent research to V1. Added per-channel degraded-narrative policy so a failed Stage 3 can never auto-publish (§8.5). Added subscriber consent requirements distinct from newsletter opt-in, and dropped push notifications from V0 given the real subscription model is narrower than draft v2 assumed (§14). Decided the dashboard presentation approach (§13) using the newly-discovered Scanner precedent. Reversed the implementation dependency order to `e3d` → `e3d-corp` → `e3d-applied` (§25). Added run-lifecycle/idempotency/reconciliation, prompt-injection defenses, and citation-freshness requirements (§9, §21) that draft v2 left unspecified.
- v4 (2026-09-02): Wrote the three per-repo `codex-spec-runner`-ready phased specs (§25), grounded in direct verification of each repo's real code rather than the plan-level description in v3. Confirmed `e3d-corp` already has a working, bearer-token-authenticated webhook-intake pattern (`/webhooks/e3d-applied-lead`, `/webhooks/e3d-trade-outcomes` in `lib/web/server.js`) — resolved §27's open question about whether such a surface exists, and the new Financial Stress Monitor intake follows that exact pattern rather than a new mechanism. Confirmed the outbound release call should mirror `lib/trade/client.js`'s existing header-auth/retry pattern precisely. Confirmed `e3d-applied`'s AI Opportunity Scanner page/content/API-route structure as the literal template for the new dashboard page. Each per-repo spec ships concrete defaults for previously-open numeric decisions (6-hour cadence, 1.0-point disagreement threshold) explicitly flagged as starting points for Chris to tune, not considered final answers.
