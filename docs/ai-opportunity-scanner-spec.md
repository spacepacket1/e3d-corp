# AI Opportunity Scanner — Product & Implementation Spec

## Status

**Pursuing** — approved by Chris 2026-08-28, `e3d-corp` opportunity `8d49c9a5-0005-46b9-bb72-15a4e5d3dcc7`, with one product modification (see below).

### Approved modification: paired consultation

The $99 report is paired with roughly an hour of Chris's own time to discuss it with the customer. This changes the V1 offer from a purely automated, zero-human-touch product to: automated report + a human follow-up conversation. Implications for implementation planning:

- The V1 non-goals list (§43) still holds for the *analysis* — no CRM/Drive/ERP integration, no autonomous customer-system actions. The consultation is a manual, scheduled human step, not a new autonomous capability.
- The scan lifecycle (§32) needs a state for scheduling/holding the consultation (e.g. between `delivered` and `converted`/`completed`), and the report/next-steps section (§24, §25) should surface booking it.
- This materially changes unit economics and scalability versus a pure-automation product — Chris's time is the actual bottleneck resource now, not inference cost. Whatever success-criteria are declared before launch (§53, §57 item 7) should account for how many scans-with-consultation Chris can realistically sustain per week.
- Booking/scheduling should reuse whatever calendar integration already exists (e3d-corp's `futco` instance already has a Google Calendar integration wired for its own outreach flow) rather than building a new one, per the "reuse aggressively" instruction in §58.

## Second Review (Fable, 2026-08-28)

Same pattern as the earlier `e3d-corp`/`e3d-trade` spec: this document was spec'd to production-hardened completion (59 sections — configurable scoring weights, a 12-state lifecycle, a 12-object data model, 15+ telemetry events, formal idempotency guarantees, a prompt-injection test suite) before a single stranger has paid a dollar. Fable's review, in full, confirmed:

- **Positioning is unresolved, not wrong.** With the paired-consultation add, this looks a lot like a cheaper, self-serve-initiated front door into the existing AI Opportunity Audit tier, not a fully distinct product. Both answers are fine — but V1 should pick one explicitly, because it changes what "success" means (product revenue vs. funnel/qualification efficiency).
- **The consultation changes what needs to be built, not just priced.** It caps throughput to however many hours/week Chris has (his calendar, not inference cost, is now the real constraint) — this is a validation-scale product, not yet a revenue-scale one. It also makes §29's automated human-review queue and most of §30's report validation redundant: Chris reviews every report live, in the call. Cut that pipeline for V1. The product also isn't really "self-serve" anymore (§59's "without talking to us" framing no longer holds) — better framed as: intake + AI-drafted report as call prep + advisor session.
- **Skip the Mac-mini-queue architecture (§26-27) entirely.** Confirmed independently (DNS + PM2 config): `e3d.ai` and `e3d-applied` already run on AWS, not this machine, and there's no stated need for local/private inference here. Call cloud model APIs directly from wherever this is deployed.
- **The biggest untested assumption isn't analysis quality — it's distribution and trust.** Nothing in the spec addresses why a stranger lands on this page and pays, versus asking ChatGPT the same question for free. Every section optimizes for what happens *after* someone already decided to pay. That's the thing to test first and cheapest.
- **Sharpest possible cut, worth taking seriously**: a manual-concierge V0 with *zero new product code* — a Stripe payment link, an off-the-shelf form (Typeform or similar), Chris running the analysis by hand through Claude and writing the first 5-10 reports himself, then the call. Tests the actual open question (will strangers pay, is the call worth it) in days, before any automated pipeline is justified. This is the identical "prove it small before building it" move that worked on the governance-layer project earlier today.

## V1 Scope (post-review)

**Build, for the automated version:**
- Landing page on `e3d-applied`.
- Stripe checkout — reuse `spacepacket`'s existing payment/entitlement infrastructure rather than building new payment plumbing; single price, no tiers.
- One intake form — single page, no resumability/multi-step-wizard state machine.
- One server-side pipeline: LLM call → candidate opportunities as structured JSON → a simple hardcoded-weight scoring function (not configurable) → LLM call to render report copy.
- A web report page (skip a downloadable/PDF version unless genuinely trivial with existing tooling).
- A booking link into Chris's existing Google Calendar integration for the consultation.
- ~5 telemetry events (paid, intake completed, report delivered, call booked, rated useful) — a spreadsheet is fine if that's faster than building a dashboard.

**Explicitly deferred** (sections below are kept for reference, not being built now): the full scan lifecycle state machine (§32) — collapse to a handful of status values; formal idempotency beyond a basic Stripe-webhook signature check + session-id dedupe (§33); the Mac-mini-queue pattern (§26-27); configurable scoring weights (§18); the 12-object data model (§31) — a couple of tables with JSON columns is enough; the automated review/validation pipeline (§29-30) — the call replaces it; the full security/prompt-injection test suite (§39, §51) beyond basic instruction/data separation — Chris reads every report before/during the call; file uploads, distribution attribution, a BI dashboard, and the Enhanced Scan/V2 ladder (§15, §36, §42, §44-45).

**Kept as explicit non-negotiables**, per Fable: "recommend not automating" as a valid, desired output (§2); upsell/CTA logic must never influence opportunity scoring (§25, §54); "AI reasons, code enforces" for the scoring step even though it's now a fixed formula, not a tunable system (§18, §54); the falsifiability framing and "don't solve weak demand with more architecture" (§55); reuse existing infrastructure aggressively rather than rebuilding payments/entitlements (§31, §58, Addendum) — confirmed real via direct infra inspection, not assumed.

**Open question for Chris, not decided here:** run the manual-concierge V0 (no code) for the first handful of customers before building any of the above, or go straight to the automated V1? Fable's recommendation is the former. The phased implementation ticket below builds the automated V1 either way, so it's ready when needed.

---

**Original status: Proposed**

This specification is intended to enter the FutCo operating pipeline through:

```text
e3d-corp
   ↓
Opportunity / Proposal / Decision
   ↓
e3d-pilot
   ↓
implementation planning / review
   ↓
codex-spec-runner
   ↓
phased implementation / testing / deployment
```

Do not treat this document as automatic authorization to deploy production changes or enable financial side effects.

`e3d-corp` should evaluate the business opportunity and approve the work before implementation begins.

---

# 1. Product

## AI Opportunity Scanner

A self-service paid FutCo product that helps a business identify, evaluate, and prioritize opportunities to use AI.

A customer should be able to:

```text
discover product
    ↓
pay
    ↓
describe business
    ↓
provide useful context
    ↓
receive automated analysis
    ↓
receive prioritized AI opportunities
    ↓
understand expected value / difficulty / risk
    ↓
choose what to do next
```

The system should produce a useful standalone outcome even if the customer never purchases another FutCo service.

It must **not** be a disguised lead-generation form whose inevitable recommendation is to hire FutCo.

---

# 2. Core Product Promise

> **Tell us how your business works. We will identify where AI is most likely to save time, reduce cost, increase capacity, or create new revenue—and tell you what is actually worth doing first.**

The product should prioritize practical opportunity over AI novelty.

The scanner should be capable of recommending:

```text
automate this
augment this
keep this human
use an off-the-shelf product
build something custom
investigate further
do nothing
```

A recommendation to **not automate** is a valid and desirable result.

---

# 3. Target Customer

Initial target:

* owner-led businesses
* small and midsize companies
* technical founders
* professional-services firms
* agencies
* SaaS companies
* businesses with repetitive knowledge work
* businesses evaluating AI but unsure where to begin

The scanner should not assume the customer is technically sophisticated.

---

# 4. Initial Commercial Offer

## V1 Product

**AI Opportunity Scanner**

Initial price hypothesis:

**$99 one-time**

Price should remain configurable rather than hard-coded.

Customer receives:

* structured business assessment
* top AI opportunities
* ranked priorities
* estimated business impact
* estimated implementation effort
* automation feasibility
* data/context requirements
* integration requirements
* risk considerations
* human-approval requirements
* recommended autonomy level
* estimated time-to-value
* recommended next action
* web report
* downloadable/shareable report if practical in V1

Do not implement multiple pricing tiers unless existing infrastructure makes this essentially free.

---

# 5. Strategic Purpose

The scanner has several simultaneous jobs.

## Customer value

Provide a concrete AI roadmap.

## Product validation

Learn what businesses actually want AI to do.

## Distribution

Create a low-friction paid entry point into FutCo.

## Qualification

Identify customers with high-value implementation opportunities.

## Revenue

Create an automated transactional product.

## Organizational learning

Generate structured data about:

* business pain points
* repeated workflow patterns
* common AI opportunities
* industries
* willingness to pay
* conversion
* implementation demand

The scanner should therefore be designed as both a product and a learning system.

---

# 6. Success Condition

The primary question is not:

> Can an LLM generate an impressive report?

It is:

> **Will a business pay for this, receive something they consider useful, and take a meaningful next action?**

The system must capture enough telemetry to answer that objectively.

---

# 7. V1 User Journey

## Step 1 — Product landing page

Recommended location:

```text
futco.ai/ai-opportunity-scanner
```

or the location most consistent with the current FutCo routing architecture.

Page should explain:

* problem
* product
* what customer receives
* price
* expected input
* expected output
* privacy expectations
* CTA

Primary CTA:

```text
Start My AI Opportunity Scan
```

---

## Step 2 — Stripe checkout

Use existing FutCo Stripe infrastructure where possible.

Flow:

```text
product page
    ↓
Stripe Checkout
    ↓
payment confirmation
    ↓
scanner job / customer entitlement created
```

Payment state must be verified server-side.

Do not trust client-side success redirects as evidence of payment.

Webhook handling must be:

* authenticated
* idempotent
* retry-safe

---

# 8. Intake

After payment, collect structured information about the business.

V1 should optimize for:

> enough information for useful analysis without creating a one-hour questionnaire.

Target completion time:

**approximately 10–15 minutes**

Suggested intake groups follow.

---

# 9. Company Profile

Collect:

* company name
* website
* industry
* company description
* number of employees / size range
* approximate revenue range optional
* customer type
* major products/services
* geographic scope

Avoid requiring sensitive financial information.

---

# 10. Business Goals

Ask customer to rank or select goals such as:

* save employee time
* reduce operating cost
* increase sales
* improve customer support
* produce more content
* improve decision-making
* speed software development
* improve internal knowledge access
* improve reporting
* reduce repetitive administrative work
* improve quality/consistency
* create new products
* create new revenue
* other

---

# 11. Workflow Inventory

Ask about recurring activities.

Examples:

* email
* customer service
* sales prospecting
* proposals
* contracts
* document processing
* invoicing
* accounting
* research
* scheduling
* reporting
* marketing
* social media
* content
* software development
* data entry
* CRM updates
* internal knowledge questions
* onboarding
* recruiting
* compliance
* analytics

For each important workflow, try to capture:

```text
workflow name
people involved
frequency
approximate time consumed
inputs
outputs
systems involved
pain level
error rate / quality concern
whether human judgment is required
```

Do not require every field for every workflow.

---

# 12. Technology Stack

Ask which systems they use.

Examples:

* Google Workspace
* Microsoft 365
* Gmail
* Outlook
* Slack
* Teams
* Salesforce
* HubSpot
* QuickBooks
* Xero
* Shopify
* Stripe
* Notion
* Google Drive
* Dropbox
* GitHub
* Jira
* Zendesk
* industry-specific applications

Allow free-form additions.

---

# 13. AI Usage Today

Collect:

* ChatGPT
* Claude
* Gemini
* Copilot
* coding assistants
* automation tools
* Zapier / Make / n8n
* internal AI tools
* none

Ask briefly:

> What has worked?

> What has disappointed you?

---

# 14. Constraints

Capture concerns such as:

* confidential information
* regulated data
* customer privacy
* financial authority
* legal authority
* security
* accuracy
* auditability
* human approval requirements
* inability to change existing systems
* budget
* staff resistance

These constraints must affect recommendations.

---

# 15. Optional Context

V1 may accept:

* website URL
* pasted text
* uploaded documents

Do not make broad SaaS integrations a V1 requirement.

Google Drive, CRM, email, ERP, and other connected-data analysis belong to a later Enhanced Scan unless the required infrastructure already exists and can be safely reused with minimal work.

---

# 16. Analysis Pipeline

The scanner should use a structured pipeline rather than one giant LLM prompt.

Conceptual flow:

```text
Intake
  ↓
Normalize business context
  ↓
Identify workflows
  ↓
Generate candidate opportunities
  ↓
Evaluate candidates
  ↓
Apply risk / feasibility constraints
  ↓
Score candidates
  ↓
Rank opportunities
  ↓
Generate recommendation explanations
  ↓
Generate roadmap
  ↓
Generate report
```

Each major stage should have a structured schema.

---

# 17. Candidate Opportunity Model

Every candidate opportunity should become a structured object.

Example:

```yaml
opportunity:
  id: opp_123

  title: Automate first-pass customer email triage

  workflow:
    name: Customer support email
    frequency: daily

  problem:
    summary: Employees manually classify and route inbound support requests

  proposed_ai_role:
    type: augmentation

  expected_outcome:
    primary: time_saved

  score:
    value: 8
    feasibility: 9
    time_to_value: 9
    data_readiness: 8
    risk: 3
    integration_complexity: 3
    confidence: 0.84

  recommendation:
    priority: do_now

  autonomy:
    recommended_level: 2

  human_gate:
    required: true
    reason: Customer-facing responses should initially require review

  implementation:
    likely_systems:
      - Gmail
      - CRM

  build_vs_buy:
    recommendation: configure_existing_tool

  rationale:
    ...

  invalidation:
    ...
```

Exact schema should be derived during implementation.

---

# 18. Scoring Model

Do not let an LLM arbitrarily determine ranking.

The model may estimate inputs, but deterministic code should calculate the final ranking from explicit dimensions.

Initial dimensions:

```text
Business value
Frequency
Labor intensity
Automation feasibility
Data readiness
Integration complexity
Risk
Time-to-value
Strategic leverage
Confidence
```

Potential normalized values:

```text
0–10
```

The scoring algorithm should be transparent and testable.

A simple model is preferable to a falsely precise complex model.

Example conceptual relationship:

```text
Opportunity Score =
    Value
  + Frequency
  + Feasibility
  + Data Readiness
  + Time-to-Value
  + Strategic Leverage
  - Risk
  - Integration Complexity
```

Do not use this exact formula without evaluating normalization/weighting.

Weights should be configurable.

---

# 19. Classification

Each opportunity should receive a clear recommendation.

Possible classifications:

```text
DO NOW

INVESTIGATE

LATER

USE EXISTING SOFTWARE

KEEP HUMAN

NOT WORTH AUTOMATING
```

This classification may be more useful to customers than a numeric score alone.

---

# 20. Autonomy Assessment

Use the governance principles FutCo is developing.

For each opportunity recommend an appropriate level of AI autonomy.

Example:

```text
LEVEL 0
Research / analysis only

LEVEL 1
Draft / recommend

LEVEL 2
Prepare complete action, human approves

LEVEL 3
Execute bounded actions after explicit approval

LEVEL 4
Execute autonomously within deterministic limits

LEVEL 5
Broad autonomous operation
```

V1 should be conservative.

Most business recommendations should probably begin at levels 1–3.

---

# 21. Risk Analysis

For each meaningful opportunity consider:

* privacy
* data sensitivity
* financial consequences
* legal consequences
* customer-facing risk
* hallucination/error impact
* reversibility
* required audit history
* human approval
* system access
* credential scope
* operational dependency

The scanner should never casually recommend broad autonomous authority merely because a workflow appears automatable.

---

# 22. Build vs. Buy

The scanner should explicitly consider:

```text
existing SaaS feature
off-the-shelf AI product
workflow automation platform
custom AI integration
custom agent
manual process
```

FutCo should not recommend custom development where inexpensive existing software solves the problem adequately.

This is essential for product credibility.

---

# 23. ROI Model

Where sufficient customer information exists, estimate:

* hours currently spent
* approximate labor cost
* potential percentage reduced
* possible time savings
* estimated implementation complexity
* approximate payback category

Avoid false precision.

Prefer:

```text
LOW
MEDIUM
HIGH
```

or ranges over invented dollar precision where inputs are weak.

Example:

```text
Estimated time saved:
5–8 employee hours/week

Implementation effort:
Low

Expected payback:
Less than 3 months

Confidence:
Medium
```

If there is insufficient data, explicitly say so.

---

# 24. Final Report

The output should be visually polished and useful without explanation from FutCo.

Recommended sections:

## Executive Summary

* what we learned about the company
* overall AI readiness
* biggest opportunity
* biggest constraint

## Top Opportunities

Ranked list of approximately 5–10.

## Opportunity Cards

Each includes:

* problem
* recommendation
* expected value
* feasibility
* risk
* effort
* time-to-value
* autonomy recommendation
* implementation approach

## Quick Wins

Things customer could implement immediately.

## Strategic Opportunities

Higher-value but more involved projects.

## What Not to Automate

At least when applicable.

## AI Architecture Recommendation

High-level recommendation based on company context.

Examples:

```text
simple SaaS tools
workflow automation
company knowledge/context layer
MCP
agentic workflow
local/private model
human approval layer
```

Do not force the FutCo architecture onto every customer.

## 30 / 60 / 90-Day Roadmap

Prioritized sequence.

## Next Steps

Clear choices.

---

# 25. FutCo Upsell

The report may recommend FutCo services when genuinely appropriate.

Possible next actions:

```text
Do this yourself
Use an existing product
Buy an enhanced scan
Book an AI Opportunity Audit
Start an AI Business Upgrade Sprint
Have FutCo design/build a specific workflow
```

Upsell logic must not affect opportunity scoring.

Product analysis and commercial CTA should remain separate.

---

# 26. Product Architecture

Recommended high-level deployment boundary:

```text
                   PUBLIC / AWS

futco.ai
    │
Scanner landing page
    │
Stripe
    │
Intake
    │
Job record
    │
Customer/report state
    │
Economic telemetry
    │
    ├────────────────────────────┐
    │                            │
    ▼                            ▼
Cloud model/API             Mac mini agents
where appropriate           where appropriate
                                 │
                                 ▼
                         analysis result
    │                            │
    └──────────────┬─────────────┘
                   ▼
                Report
                   │
              Customer
```

AWS/public infrastructure should own durable customer state.

The Mac mini may perform analysis but should not become the authoritative customer/payment database.

The product must continue accepting purchases even when the Mac mini is unavailable.

---

# 27. Mac Mini Boundary

Do not expose the Mac mini directly to public inbound traffic.

Preferred communication:

```text
Mac mini
   ↓ outbound authenticated request
AWS job API / queue
```

Possible pattern:

```text
AWS creates job
      ↓
Mac mini polls or consumes authenticated queue
      ↓
claims job
      ↓
processes
      ↓
posts structured result
```

If existing secure infrastructure provides a superior equivalent pattern, reuse it.

---

# 28. Model Strategy

The scanner should be model-independent.

Potential models may include:

* Claude
* Codex where appropriate
* Grok where appropriate
* local Qwen
* other future models

Model selection should be based on:

```text
capability
privacy
latency
cost
reliability
structured-output quality
```

Do not architect business logic around one vendor.

---

# 29. Human Review

V1 should support optional human review.

Recommended initial behavior:

```text
normal-confidence scan
→ automated analysis
→ review queue
→ human spot-check
→ release
```

However, design the pipeline so automatic delivery can later be enabled when quality data justifies it.

Human review should be triggered especially when:

* analysis confidence is low
* input is sparse
* recommendations involve high-consequence decisions
* report generation fails validation
* conflicting recommendations appear
* policy/safety rules trigger

---

# 30. Report Validation

Before release, deterministic validation should verify:

* required sections exist
* at least N opportunities exist unless system explicitly concludes otherwise
* every opportunity has required scores
* scores are within valid ranges
* ranking matches score calculation
* no broken references
* no unsupported dollar claims
* no malformed markup
* no internal prompts/debug data exposed
* no secrets/credentials present
* report belongs to correct customer/job

---

# 31. Data Model

Likely primary objects:

```text
Customer

ScanOrder

ScanJob

BusinessProfile

Workflow

CandidateOpportunity

ScoredOpportunity

ScanReport

Payment

Entitlement

ScanEvent

ReviewDecision
```

Reuse existing schemas where appropriate.

Do not create duplicate customer/payment systems if FutCo already has equivalents.

---

# 32. Scan Lifecycle

Suggested state machine:

```text
created
↓
awaiting_payment
↓
paid
↓
awaiting_intake
↓
ready
↓
processing
↓
validation
↓
review_required | ready_for_delivery
↓
delivered
↓
viewed
↓
converted | completed
```

Also support:

```text
failed
refunded
cancelled
```

State transitions should be deterministic.

---

# 33. Idempotency

Financial and job operations must be idempotent.

Examples:

* Stripe webhook replay must not create multiple scans
* job retry must not create multiple reports without explicit versioning
* repeated fulfillment must not create duplicate entitlements
* repeated callback from analysis worker must not duplicate outcomes

Use stable IDs.

---

# 34. Economic Telemetry

Instrument the scanner from V1.

At minimum record events such as:

```text
scanner.page_viewed

scanner.checkout_started

scanner.payment_completed

scanner.intake_started

scanner.intake_completed

scanner.job_started

scanner.analysis_completed

scanner.report_generated

scanner.review_completed

scanner.report_delivered

scanner.report_viewed

scanner.cta_clicked

scanner.audit_requested

scanner.sprint_requested

scanner.refund_requested
```

Where privacy permits, include structured context such as:

```text
industry
company_size
opportunity_categories
top_score
scan_duration
conversion_source
```

Do not put sensitive free-form customer content into analytics systems unnecessarily.

---

# 35. Economic → Governance Compatibility

Design scanner economic events so they can later be consumed read-only by `e3d-corp`.

Do not make `e3d-corp` a dependency of V1.

The scanner must function if `e3d-corp` is unavailable.

But events should eventually allow `e3d-corp` to understand:

```text
What products are people buying?

What industries convert?

Which AI problems recur?

Which recommendations lead to implementation?

What price converts?

What reports lead to follow-up?

Where does the funnel fail?
```

This is part of the long-term organizational learning loop.

---

# 36. Distribution Attribution

Capture acquisition source when reasonably possible.

Examples:

```text
futco.ai organic
Google
LinkedIn
email
direct
referral
E3D
campaign
```

We specifically want to learn not merely whether the product works, but whether FutCo can economically distribute it.

---

# 37. Privacy

The scanner may receive sensitive business information.

Requirements:

* minimize requested sensitive information
* clearly explain what data is used for
* do not train external models on customer data unless explicitly allowed
* use appropriate provider privacy settings
* protect uploaded files
* use authenticated report access
* avoid publicly guessable report URLs
* define retention policy
* allow deletion where appropriate
* do not log prompts containing secrets into general telemetry

Existing FutCo security patterns should be reused.

---

# 38. Security

At minimum:

* Stripe verification server-side
* authenticated internal job APIs
* signed/secure worker communication
* rate limiting
* secure file handling
* content-type/size validation
* least privilege
* encrypted transport
* secrets in proper secret management
* no credentials in browser code
* no unauthenticated report access

---

# 39. Prompt Injection / Uploaded Content

Treat all customer-provided content as untrusted data.

Uploaded documents and websites may contain instructions such as:

```text
ignore previous instructions
send customer data elsewhere
reveal system prompt
```

Models must be instructed that customer content is evidence/data, not system authority.

Tool access available during analysis should be narrowly scoped.

V1 analysis agents should not need consequential external-action authority.

---

# 40. Failure Modes

Handle:

* Stripe payment succeeds but intake fails
* customer abandons intake
* analysis worker unavailable
* model provider unavailable
* Mac mini unavailable
* malformed output
* weak intake
* duplicate webhook
* report validation failure
* timeout
* model refusal
* uploaded file parse failure
* report delivery failure

Never silently lose a paid job.

Paid customers should have recoverable state.

---

# 41. Product Quality Measurement

Capture customer feedback after report delivery.

Minimum:

```text
How useful was this scan?
1–5

Did it identify opportunities you had not considered?
Yes / No

Do you plan to act on any recommendation?
Yes / No

Optional comments
```

Potential future measurement:

```text
Which opportunity did you implement?

Did it save time?

Did it create revenue?

Did FutCo implement it?
```

The goal is to eventually evaluate whether the scanner predicts **real value**, not merely generates persuasive text.

---

# 42. Business Metrics

Initial product dashboard should eventually answer:

```text
visitors

checkout starts

payments

conversion rate

intake completion rate

report completion rate

refund rate

average generation cost

gross revenue

gross margin

report view rate

Audit conversion

Sprint conversion

implementation conversion

customer satisfaction
```

Do not build an elaborate BI system for V1 if existing analytics can answer these simply.

---

# 43. V1 Explicit Non-Goals

Do not build yet:

* CRM connectors
* Gmail analysis
* Google Drive deep integration
* ERP integration
* autonomous customer-system actions
* generalized FutCo agent marketplace
* complex subscription system
* multi-product credit ledger redesign
* E3D Token integration unless trivially reusable
* NFT integration
* AI-generated live system changes
* fully autonomous implementation
* broad `e3d-corp` control
* complex multi-agent debate architecture
* industry-specific scanners
* white-labeling
* reseller system
* mobile application

V1 proves demand and report quality.

---

# 44. Possible V2

If V1 validates demand:

## Enhanced Scan

Potential price:

**$299–$499**

Adds selected evidence such as:

* website crawl
* document uploads
* Google Drive
* workflow artifacts
* more detailed ROI
* deeper architecture design

---

# 45. Possible Product Ladder

Longer term:

```text
Free AI content / lightweight tools
             ↓
AI Opportunity Scanner
          ~$99
             ↓
Enhanced Scan
       ~$299–$499
             ↓
AI Build Spec
       ~$199–$499
             ↓
AI Opportunity Audit
             ↓
AI Business Upgrade Sprint
             ↓
Managed AI Ops / recurring service
```

Do not implement this entire ladder now.

The scanner should simply avoid making this path difficult later.

---

# 46. Relationship to `e3d-corp`

This project is itself a good test of the FutCo organizational architecture.

The originating opportunity should be represented in `e3d-corp`.

Conceptually:

```text
Event:
Economic-stack review reveals production payment infrastructure but weak adoption.

Opportunity:
Create a low-friction automated paid AI product aligned with FutCo's AI-services pivot.

Proposal:
Build AI Opportunity Scanner V1.

Decision:
Approve / reject / modify.

Action:
Delegate implementation to e3d-pilot.

Outcome:
Product shipped and measurable customer behavior observed.

Experience:
Did the scanner generate useful outcomes, revenue, qualified leads, and learning?
```

`e3d-corp` should preserve the causal chain.

---

# 47. Relationship to `e3d-pilot`

If approved, `e3d-pilot` should:

1. inspect relevant repos
2. identify current FutCo website/payment/reporting infrastructure
3. identify reusable components
4. determine repo ownership
5. propose implementation phases
6. identify security/privacy risks
7. critique this spec
8. resolve contradictions against actual code
9. produce an implementation-ready plan
10. hand approved phases to CSR

Do not assume a new repo is required.

Prefer extending the appropriate existing FutCo application unless code inspection indicates separation is justified.

---

# 48. Relationship to CSR

CSR should implement against explicit phases and acceptance criteria.

Recommended general progression:

```text
Phase 0
Source-of-truth repo inspection

Phase 1
Product/data model + landing page

Phase 2
Stripe purchase + entitlement

Phase 3
Structured intake

Phase 4
Analysis pipeline

Phase 5
Scoring + report

Phase 6
Delivery + customer access

Phase 7
Telemetry + feedback

Phase 8
Security / failure recovery / hardening

Phase 9
Production deployment
```

`e3d-pilot` should revise phases according to actual repo architecture.

---

# 49. Acceptance Criteria — Product

V1 is not complete unless:

1. A new visitor can understand what the scanner does.

2. A customer can pay using Stripe.

3. Successful payment creates exactly one valid scan entitlement/order.

4. Customer can complete structured intake.

5. Intake survives browser/session interruption where practical.

6. A paid completed intake creates an analysis job.

7. The job produces structured candidate opportunities.

8. Opportunities are scored deterministically.

9. A useful ranked report is generated.

10. Report includes both positive recommendations and appropriate cautions.

11. Report can recommend not automating something.

12. Report does not automatically recommend FutCo custom work for every opportunity.

13. Customer can securely access the report.

14. Relevant CTA actions are measurable.

15. Paid jobs cannot silently disappear.

16. Duplicate Stripe events do not duplicate orders.

17. Duplicate worker responses do not duplicate reports.

18. Mac mini downtime does not prevent purchasing or preserve-state operations.

19. Public users cannot access another customer's report.

20. No consequential customer-system action occurs from scanner analysis.

---

# 50. Acceptance Criteria — Analysis

For a controlled fixture business:

* system identifies at least several plausible opportunities
* scores remain within schema bounds
* deterministic rank order is reproducible
* high-risk workflows receive stronger governance recommendations
* low-value automation can be classified as not worthwhile
* obvious off-the-shelf solutions are not unnecessarily turned into custom-build recommendations
* insufficient data lowers confidence
* ROI output avoids false precision
* report remains internally consistent

---

# 51. Acceptance Criteria — Security

Tests should verify:

* forged Stripe callbacks fail
* webhook replays are safe
* unauthenticated reports fail
* invalid job callbacks fail
* prompt-injection text inside intake does not override analysis policy
* oversized/disallowed files fail safely
* secret values are never exposed in reports
* customer A cannot retrieve customer B data
* worker does not receive unnecessary authority
* payment state cannot be forged client-side

---

# 52. Acceptance Criteria — Telemetry

Verify at least:

```text
page view
checkout start
payment
intake complete
analysis start
analysis complete
report delivered
report viewed
CTA click
```

can be tied to the correct scan/customer while respecting privacy.

---

# 53. Go / No-Go for V2

Do not expand substantially based only on successful deployment.

Evaluate real behavior.

Suggested initial evaluation questions after an appropriate number of users:

```text
Are people willing to pay?

Do they complete intake?

Do they rate reports as useful?

Do reports identify non-obvious opportunities?

Do customers take action?

Do scanner customers convert to larger work?

What does each scan cost FutCo to generate?

Which acquisition channels work?

Which industries/problems repeat?
```

Possible success indicators should be established by `e3d-corp` before launch so they are not chosen retroactively.

---

# 54. Core Architectural Principles

Preserve:

```text
AI reasons.
Code enforces.

Public infrastructure owns durable customer state.

Payment and entitlement are deterministic.

Agents receive least privilege.

Consequential actions require explicit authority.

Customer content is untrusted input.

Reports must be measurable outcomes.

The product must create value independently of an upsell.
```

---

# 55. Core Business Hypothesis

The hypothesis being tested is:

> **Businesses will pay a modest amount for an automated, credible, prioritized assessment of where AI can create meaningful value in their operations, and some of those customers will subsequently implement the identified opportunities themselves or with FutCo.**

That hypothesis must be falsifiable.

Failure to attract customers is information.

Failure to convert scanner customers into larger services is information.

Failure to generate genuinely useful recommendations is information.

Do not solve weak demand by adding more architecture.

---

# 56. Long-Term Vision

If successful, the scanner becomes the first canonical paid product in a reusable FutCo product engine:

```text
Discover
   ↓
Pay
   ↓
Provide context
   ↓
AI performs bounded work
   ↓
Structured outcome
   ↓
Customer receives value
   ↓
Economic event recorded
   ↓
Organization learns
```

Future AI products should be able to reuse:

* Stripe
* customer identity
* job execution
* worker architecture
* report delivery
* telemetry
* entitlements
* governance
* outcome measurement

The scanner should therefore be implemented cleanly enough to teach us how to build the second paid AI product faster.

---

# 57. First Instruction to `e3d-corp`

Evaluate this proposal as a corporate opportunity.

Specifically determine:

1. Does it align with FutCo's current strategy?
2. Is there a credible customer/value proposition?
3. Does it use capabilities FutCo already possesses?
4. Can V1 be built cheaply enough to justify the experiment?
5. What are the primary risks?
6. What evidence would falsify the opportunity?
7. What measurable success criteria should be declared before launch?
8. Should FutCo approve, reject, or modify the proposal?

If approved:

> Create the appropriate Decision and delegate the implementation Action to `e3d-pilot`.

Do not hand directly to CSR unless that is already the approved FutCo workflow.

---

# 58. First Instruction to `e3d-pilot`

If this reaches `e3d-pilot` through an approved `e3d-corp` Action:

> Inspect the actual FutCo/E3D repos and infrastructure, critique this spec against source-of-truth code, identify the smallest implementation that produces a real paid end-to-end AI Opportunity Scan, reuse existing capabilities aggressively, create phased implementation specifications with explicit acceptance tests, and route approved implementation phases through Codex Spec Runner.

The goal is not to demonstrate sophisticated AI.

The goal is to ship a product that a stranger will pay for and find useful.

---

# 59. Product North Star

> **A stranger should be able to discover FutCo, spend $99 without talking to us, give the system enough information about their business, and receive a report valuable enough that they are glad they bought it.**

Everything in V1 should serve that test.

---

# Addendum: Chris's architectural default

I would start by treating the AI Opportunity Scanner as a new product inside the existing FutCo web/app stack, not as a brand-new repo just because it is a new product.

My default architecture would be:

- `e3d-applied` / `futco.ai` owns the public product page, Stripe checkout, intake UI, report UI, and customer-facing state.
- Existing AWS services own durable job/payment/report records.
- The Mac mini agent layer performs deeper analysis where appropriate.
- `e3d-corp` governs the opportunity and work.
- `e3d-pilot` plans the implementation.
- CSR executes the approved implementation phases.

I would create a new repo only if the implementation review shows that the scanner needs a genuinely independent long-running service with its own deployment lifecycle, queue/worker model, persistence, or API contract.

So I'd tell `e3d-pilot`:

> Do not create a new repo by default. First inspect the existing FutCo web, Stripe, job-processing, reporting, and agent infrastructure. Extend existing repos where the boundaries are clean. Create a new repo only if there is a clear service boundary that would otherwise create unhealthy coupling.
