---
selected: risk-guard-prototype
reason: approved idea implementation
focus: default
---

# Candidates

## Proposed Candidates

### Candidate risk-guard-prototype: Inbound request risk assessment: minimal HOLD/APPROVE prototype
Duplicate: no
Dedup rationale: No existing idea in this repo's ledger addresses inbound risk/request gating -- the four prior ideas (hash anchor workflow, demo/sandbox mode, pipeline velocity indicators, CLI --json/--dry-run flags) are all unrelated tooling and all rejected. This is a genuinely new capability, not an extension of any of them.
Category: product-strategy
Analogy: Same shape as e3d-corp's existing opportunity.prospect -> opportunity.communicator -> Proposal path, inverted: instead of scoring outbound opportunities to pursue, this scores inbound requests to gate. Reuses the authority-level/ACTION_POLICY gating and Decision/Outcome separation already built for FINANCIAL_ACTION, rather than inventing new safety machinery.
Attraction (1-5): -
Retention (1-5): -
Effort: medium
Revenue (1-5|n/a): -
Description: Prototype the smallest possible slice of a 'Business Decision Guard' inside e3d-corp's existing runtime, reusing its architecture rather than building new machinery: one new Event type representing an inbound consequential request (e.g. a vendor invoice or payment request, added via CLI for this prototype rather than a live Gmail/Drive integration -- that's explicitly out of scope), one new role (risk.assess, parallel in shape to the existing opportunity.prospect role) that reads the request plus whatever evidence the existing evidence-gathering layer can surface (prior correspondence/vendor history if any exists in the event log) and returns a structured risk verdict (HOLD / APPROVE / CHECK) with reasoning, and one new action type (e.g. flag-payment-request) registered in lib/authority/policy.js's ACTION_POLICY at FINANCIAL_ACTION (level 3) authority, so nothing about the request is ever auto-approved -- it always produces a Proposal that requires an explicit human Decision before anything fires, exactly like every other level-3 action in this runtime. Deliverable is: CLI command to submit a request event, the risk.assess role, the Proposal it generates, and a test exercising the full Event to Proposal path (not the Decision/Action execution UI, and not any real external integration). This is a fast prototype to validate the concept, not the full product.
