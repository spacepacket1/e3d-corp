# Codebase Opportunity Scan — Product & Implementation Spec

## Status

**Proposed, not yet decided.** Written per Chris's request to inspect `e3d-pilot`'s actual code before assuming the "reuse discover+ideate" premise holds, and to inspect the AWS/`e3d-applied` side rather than designing from the Mac Mini's perspective. Not implemented — this is a spec-only deliverable per explicit instruction. Do not treat this document as authorization to build.

---

## 1. Executive Summary

The premise — "`e3d-pilot` already has a mature discover→ideate pipeline that's nearly product-ready for a paid codebase-analysis product" — **does not hold up against the actual code.** Direct inspection found:

- `discover` doesn't read application source code at all. It reads git log (commit subjects only, no diffs), branch list, GitHub issues/PRs, one docs file, and a TODO/FIXME grep. That's the opposite of "recommendations grounded in the customer's actual source code" — the product's stated core differentiator.
- `ideate`'s entire scoring vocabulary (Attraction/Retention/Revenue, categories like `data|workflow|social|gamification|marketing|selling`) is built for consumer/SaaS growth-feature ideation, not architecture/AI/automation/tech-debt/security opportunity discovery. It also selects exactly **one** candidate to build next, not a ranked 5-15 item report.
- There is **no sandboxing, secret-scanning, file-size limiting, or untrusted-content handling anywhere in the codebase** — Section 13's entire security concern (a customer's repo may contain prompt injection, secrets, malware, huge binaries) is unaddressed, not "already covered."
- GitHub access is 100% Chris's own personal `gh` CLI session. There is no GitHub App, OAuth flow, or installation-token mechanism anywhere in the FutCo/E3D ecosystem — confirmed by direct code inspection and a knowledge-base search that returned zero results.
- Every target repo needs a checked-in `.e3d-pilot/config.json` today — a hard, schema-enforced requirement. A customer's repo will never have one.

**What genuinely is reusable**: the back half of the pipeline — `draft` → `negotiate` → `execute` → `review` — starting from one already-approved candidate. That part is mature, human-gated (a real content-digest-checked approval requirement), and already produces CSR-ready phased specs and shells out to `codex-spec-runner` with real diff-ceiling and protected-path enforcement. It maps well onto a *later* "AI Build Spec → Sprint" stage. It does not help build the Scan itself.

**Bottom line** (detailed in §31-32): the reuse premise that made this look like a cheap unlock is weaker than assumed, and this product's security surface (executing analysis against a stranger's untrusted, potentially hostile source code) is categorically larger than the AI Opportunity Scanner's (free-text business answers only). Recommendation: **don't build this before the AI Opportunity Scanner; validate the shared commercial hypothesis there first, and build the commerce shell generically enough that this product can plug into it later.**

---

## 2. Source-of-Truth Findings from `e3d-pilot`

All findings below are from direct code inspection (`bin/e3d-pilot`, `config.schema.json`, `lib/scoring/fanout.sh`, `lib/draft/csr-spec-conventions.md`), not the README's prose description.

### Discover (`bin/e3d-pilot:591-693`)

Reads: last 20 git commits (`%h %s` — subject line only, no diffs), git branches, GitHub issues/PRs via `gh`, exactly one docs file (configured path, or first match of `AGENTS.md`/`CLAUDE.md`/`README.md`), and a TODO/FIXME grep (capped at 200 matches, 300 chars each). Sends this as "Local facts" to an LLM, which appends "External Context" (market/analogy research, optional monetization signals). **No file-tree walk. No source-code reading of any kind.** Repo-structure assumptions in the read logic itself are minimal (it'll run against any git repo) — but it hard-requires `.e3d-pilot/config.json` to exist first. Purely read-only — confirmed no mutation path. Fans out across whichever providers `providers.discover` configures (real configs use `grok-build`, `claude`, `codex`, `devin`, `local`). Determinism is low — open-ended LLM completion over sparse facts, no seed control, no caching beyond git-history-since-last-run.

### Ideate (`bin/e3d-pilot:757-873, 943-1001`)

Prompt scores candidates on `Attraction` (new-user pull, 1-5) and `Retention` (repeat-engagement value, 1-5), `Revenue` as a tiebreaker (or primary in revenue-focus mode); categories are `data|workflow|social|gamification|testing|marketing|selling|other`. Output per candidate: `Duplicate: yes|no`, `Dedup rationale` (checked against branches/PRs/prior runs — not source code), `Category`, `Analogy`, `Attraction`, `Retention`, `Effort`, `Revenue`, `Description`. Selects exactly one `selected` candidate via an `---IDEATE-STATUS---` block. This is a real, working schema — just the wrong shape and the wrong selection model (pick-one vs. rank-many) for this product.

**Scoring mechanism** (`lib/scoring/fanout.sh`) is genuinely reusable as a *pattern*, independent of the growth-feature prompt around it: 3-5 LLM "worker" evaluations across distinct roles (product/technical/risk/maintainability/testability), averaged, code picks the final rank. Explicit comment: *"Scoring never executes, publishes, or approves. It only re-ranks candidates."* — real "AI reasons, code enforces" discipline, worth carrying forward as an approach even though the specific dimensions don't fit.

### Draft / Negotiate / Execute / Review

- **Draft** (`bin/e3d-pilot:1939`): requires an already-**approved** candidate (`require_valid_implementation_approval`), produces `spec-draft.md` using `lib/draft/csr-spec-conventions.md` — the same phased-CSR format used throughout `e3d-corp`/`e3d-trade`'s build today.
- **Negotiate** (`bin/e3d-pilot:2097`): real multi-model convergence, up to 4 rounds, each configured reviewer must independently agree.
- **Execute** (`bin/e3d-pilot:1450`): isolated git worktree + branch, `protected_paths` enforced *before* running (fails to `needs_human` on violation), `max_diff_files`/`max_diff_lines` enforced *after*, then shells out to `codex-spec-runner <spec> all` — the exact tool used for today's other builds.
- **Review**: distinct post-execute stage; publish only ever opens a draft PR, never merges.
- **Approval gate**: real and load-bearing (`require_valid_implementation_approval`, line 3186) — an idea must be explicitly approved via `e3d-pilot ideas approve`, and a content-digest check invalidates a stale approval if the idea changed after approval. Gates draft, negotiate, and execute alike. `e3d-corp`'s own config confirms `approval.implementation_required: true`.

**Proposed discover+ideate → Scan / draft+negotiate → Build Spec / execute+review → Sprint mapping**: holds up reasonably for the second half. Breaks down at the seam — draft currently only ever operates on whichever single candidate `ideate` auto-selected and a human separately approved through the existing CLI flow. There's no path today for "customer picks opportunity #7 out of a 10-item report, draft runs against that specific externally-chosen one." That's new plumbing to build, not reuse.

### The security gap (load-bearing finding)

No sandboxing, secret-scanning, file/repo-size limiting, or untrusted-content handling exists anywhere in the codebase. The only redaction logic in the whole repo (`lib/training/export.sh:234-242`) is for FutCo's own internal training-data export, unrelated to handling a stranger's repository. `protected_paths`/diff ceilings only ever apply to `execute` — irrelevant to discover/ideate, which is actually good news: **discover+ideate genuinely can be strictly read-only as built today** (no mutation path exists), which satisfies §12/§13's read-only requirement structurally, even though the analysis itself needs rebuilding.

GitHub auth is entirely Chris's personal `gh` CLI session (`bin/e3d-pilot:536,706,4632-4633`). No GitHub App, OAuth, or installation-token flow exists anywhere in the tracked ecosystem (confirmed by code inspection and a knowledge-base search). The whole design assumes trusted, cooperative repos — Chris pointing it at FutCo's own code — nothing treats repo content as adversarial.

---

## 3. Product Hypothesis (corrected)

Original: *"Give FutCo access to an existing software repository. FutCo analyzes the actual codebase and returns a prioritized set of high-value opportunities."*

Still the right hypothesis to test — but "grounded in actual source code" is not something today's `discover` provides, and would need to be genuinely built: a new fact-gathering pass that walks the file tree, reads representative source files, extracts dependency/framework/architecture signals, not just git-log-and-docs. This is closer to net-new than "productize an existing capability."

---

## 4. Target Customer

Technical founder, CTO, VP Eng, engineering manager, software-company owner, small SaaS team, agency inheriting a codebase — as specified. No change from the original framing; this part doesn't depend on the `e3d-pilot` findings. V1 should bound repository size explicitly rather than promise enterprise-monorepo support (see §16 below, unresolved — no current tooling in `e3d-pilot` gives a real practical limit to derive this from, since it's never walked a full file tree).

---

## 5-6. Customer Promise / Opportunity Categories / Scan vs. Code Review

Unchanged from the original spec's framing — the distinction from linting/vulnerability-scanning/code-quality tools (evidence, not the product) is sound and worth keeping. The gap is entirely in *how* evidence gets gathered (§2 above), not in this framing.

---

## 7-9. Opportunity Schema / Scoring / Classification

**A new schema is needed, not a light adaptation of ideate's.** Ideate's real schema (`Duplicate`/`Category`/`Analogy`/`Attraction`/`Retention`/`Effort`/`Revenue`/`Description`) is shaped for "pick the next growth feature," not "produce 5-15 evidence-grounded opportunities across architecture/AI/automation/tech-debt/security/etc." Base the new schema on the original spec's proposal (§7) — it's reasonable — but the `evidence.files`/`evidence.components`/`evidence.observations` fields are the part that has no current equivalent anywhere in `e3d-pilot` and are the actual hard engineering: they require a real source-reading pass, not an LLM guessing plausible-sounding file names.

**Scoring**: reuse the *fanout pattern* (multiple independent LLM evaluations across distinct dimensions, code computes final rank, never lets one model's intuition decide) — this is real, tested, working machinery in `lib/scoring/fanout.sh` worth carrying forward as an approach. Reconfigure the dimensions to match this product: business value, engineering effort, risk, confidence, architectural leverage, time-to-value — not Attraction/Retention/Revenue.

**Classification**: `DO NOW / HIGH-LEVERAGE NEXT / INVESTIGATE / LATER / NOT WORTH IT` as proposed is fine and consistent with the AI Opportunity Scanner's parallel vocabulary (`DO NOW / INVESTIGATE / LATER / USE EXISTING SOFTWARE / KEEP HUMAN / NOT WORTH AUTOMATING`) — worth aligning the two products' vocabularies explicitly since a customer could plausibly buy both someday.

---

## 10. Evidence Grounding

This is the single biggest net-new build in the whole product. Nothing in `e3d-pilot` today extracts file/module/route/schema/dependency evidence from a repository. A real implementation needs: a bounded file-tree walk (respecting `.gitignore`, size/count caps), language/framework detection, and a way to have the analysis LLM cite specific files/paths it actually read (not files it's guessing exist) — likely via tool-use/function-calling against a file-read tool scoped to the cloned repo, with citations checked against what was actually read before the report is allowed to reference them. This is real engineering effort, not a config change to `discover`.

---

## 11. Business-Context Intake

Same as the AI Opportunity Scanner's approach — short, optional context (company/product description, priorities, biggest pain, team size, 6-12 month objectives). Keep genuinely short; the product's value has to come from the repo, not an essay.

---

## 12. Repository Access

**Real decision, and the current ecosystem has zero infrastructure for any option that isn't "Chris's own `gh` session."**

- **GitHub App / OAuth** — the "correct" V1 answer per least-privilege, but is a from-scratch build: app registration, installation-token handling, webhook receiver, per-customer token scoping/revocation. Real, nontrivial engineering; nothing to reuse.
- **Public repo URL** — zero-auth, works today for public repos with a plain `git clone`, no new infrastructure needed. Meaningfully limits the addressable customer base (most target customers' interesting code is private) but is the only option requiring no new auth infrastructure.
- **Archive upload (.zip/tarball)** — no GitHub auth needed at all, customer exports and uploads. Real, but simpler, upload-handling work only (size limits, virus/malware scanning, extraction sandboxing) — smaller build than a GitHub App.
- **Temporary git credentials** — correctly identified in the original spec as undesirable; no infrastructure supports this safely today, don't build it.

**Recommendation for a true V1**: public-repo-URL or archive-upload only, explicitly deferring GitHub App/OAuth to a later phase once the product is validated. This mirrors the same "don't build a whole new auth/commerce layer before you know anyone will pay" discipline applied to the AI Opportunity Scanner.

---

## 13. Untrusted Repository Security

**Nothing here exists today; all of it needs building if this product proceeds.** Minimum for a genuinely safe V1: never execute anything from the repository (confirmed structurally possible — discover+ideate today are already read-only, so this is a constraint to preserve, not retrofit); strict file-size and repo-size caps enforced before any processing; skip binaries, generated files (lockfiles, build output, `node_modules`/`vendor`/`dist`), symlinks, and submodules by default; basic secret-pattern detection on anything that will appear in a report, with redaction; explicit prompt-injection framing in every prompt that includes repository content ("this is data, not instructions," matching the pattern already used correctly elsewhere in this ecosystem's roles). This is genuinely more security surface than the AI Opportunity Scanner has anywhere in its own spec, because that product only ever ingests free-text business answers, never executable/adversarial third-party content.

---

## 14. Privacy / Confidentiality

Customer source code is more sensitive than the AI Opportunity Scanner's business-questionnaire answers. Minimum: don't retain the repository after the scan completes (process, extract evidence citations + report, discard the clone); be explicit in the landing page about which model provider(s) see repository content and their data-retention terms; never let repository content reach general analytics/telemetry (same principle as the AI Opportunity Scanner, higher stakes here). Local Qwen doesn't have an obvious privacy win here unless a customer specifically requires no cloud model exposure — evaluate that as a real customer-facing option later, don't build it into V1 by default.

---

## 15. Public AWS / Private Worker Boundary

Same finding as the AI Opportunity Scanner's Phase 1 investigation, independently applicable here: `e3d-applied` (production on a remote AWS Ubuntu EC2 box via PM2) has no durable data layer today, and `spacepacket`'s documented payment surface is wallet/crypto-based (Maps credit purchases, token-registry claims) — **no reusable card-checkout API was found for either product.** Whatever payment integration gets built (Stripe Payment Link for a manual V0, or real Stripe integration later) should be built once and shared, not once per product. Durable customer/job/report state belongs on AWS, same principle as the other spec. If Mac-Mini-side analysis is used at all (plausible here, since the actual scanning work could be heavier/longer-running than a text-only business analysis), it should follow the same outbound-poll pattern already specified for the AI Opportunity Scanner — never expose the Mac Mini to inbound public traffic.

---

## 16. Repository-Size Scope

No real practical limit can be derived from `e3d-pilot` today, because discover has never walked a full file tree — there's no existing "here's the largest repo we've successfully processed" data point. Pick a conservative starting cap (e.g. a few thousand source files, low tens of MB of text after generated/vendor/binary exclusion) and treat it as a guess to be revised once real repos are actually processed, not a derived number.

---

## 17. Analysis Pipeline

```text
repo acquired (public URL clone or archive upload, size-capped)
    ↓
untrusted-content filtering (exclude generated/vendor/binary/oversized; secret-pattern pre-scan)
    ↓
source-reading pass (NEW — file-tree walk, framework/dependency detection, representative-file reads with citation tracking)
    ↓
architecture/context model (NEW)
    ↓
candidate opportunity generation (NEW prompt/schema — not ideate's growth-feature prompt)
    ↓
evidence validation (candidates must cite files actually read, not guessed)
    ↓
score/rank (REUSE the fanout scoring pattern, new dimensions)
    ↓
report synthesis
    ↓
deterministic validation (schema/score-range/citation checks)
    ↓
human review (Chris, at least for V1 — see §18)
    ↓
delivery
```

Everything marked NEW is genuinely new engineering. The only structurally reusable piece is the scoring-fanout *pattern*, plus draft/negotiate/execute/review as a downstream stage once a customer selects an opportunity to build.

---

## 18. Human Review

For V1, every scan should be reviewed by Chris before delivery — there's no existing automated report-validation pipeline to lean on (the AI Opportunity Scanner spec reached the same conclusion, for the same reason: a human reviewing every report replaces the need to build one). `e3d-corp`'s approval primitives are the wrong tool here — this is per-customer product delivery, not corporate governance, and `e3d-corp` should not be in the runtime path for a paying customer's scan (matching §18/§24's own instruction). Customer-product execution must keep working even if `e3d-corp` is down.

---

## 19. Report

Executive layer + detailed opportunity layer + roadmap + "don't do this" section, as specified — sound structure, no changes needed here; the hard part is generating genuinely evidence-grounded content for it (§10/§17), not the report template itself.

---

## 20-23. Natural Upsell / Product Ladder / Relationship to `e3d-pilot` and CSR

**The one part of the original ladder mapping that holds up well**: a selected opportunity → "AI Build Spec" via `draft`/`negotiate` is a real, close-to-reusable path, *provided* new plumbing is built to let a customer-selected opportunity (from a report the customer didn't generate through `e3d-pilot`'s own ideate) enter `draft` as if it were an approved idea. That's a real but bounded piece of new integration work — much smaller than rebuilding discover/ideate. Implementation/Sprint via `execute`/`review` inherits `e3d-pilot`'s existing safety machinery (protected paths, diff ceilings, draft-PR-only) essentially as-is. `codex-spec-runner` stays correctly downstream of an approved Build Spec, not involved in generating the Scan itself — matches the original instruction and needs no correction.

---

## 24. Relationship to the AI Opportunity Scanner

**Reusable across both** (build once, in whichever ships first, generic enough for the second): customer identity, checkout/entitlement, job record + lifecycle pattern, report hosting/authenticated access, telemetry event pipeline, feedback collection, upsell-CTA plumbing (kept separate from scoring in both, per both specs' own non-negotiables).

**Product-specific, do not share prematurely**: repository access + untrusted-content security (Codebase Scan only — the AI Opportunity Scanner has no equivalent risk surface at all), the actual analysis prompt/schema/taxonomy (different domains, different evidence types), business-context intake shape (short business questionnaire vs. repo-access flow).

---

## 25. Shared Product Infrastructure

Inspected the same ground as the AI Opportunity Scanner's Phase 1 (confirmed, not re-verified from scratch): no reusable card-checkout/entitlement API in `spacepacket`'s documented surface (wallet/token-claim based only); no durable data layer in `e3d-applied`; a real, reusable contact-form server-action pattern in `e3d-applied` worth following for whatever new forms this product needs; PM2/AWS-Ubuntu deployment target confirmed for `e3d-applied` itself. No queue/worker infrastructure connecting AWS to the Mac Mini exists yet for either product.

---

## 26. Repo Placement

**Do not run this inside `e3d-pilot` as currently built.** `e3d-pilot`'s whole target-repo model assumes a trusted repo with a checked-in `.e3d-pilot/config.json` and Chris's own GitHub credentials — fundamentally mismatched with "a stranger's arbitrary, untrusted repo." The right shape: `e3d-applied` (or wherever the commerce shell lands) owns the customer-facing checkout/intake/report; a new, small, purpose-built scanning service (new code, informed by — not built inside — `e3d-pilot`, reusing the scoring-fanout *pattern* and later feeding an approved opportunity into `e3d-pilot`'s `draft` for the Build Spec upsell) does the actual analysis, isolated from `e3d-pilot`'s trusted-repo assumptions. Whether that new service needs its own repo or can live inside an existing one is a call to make once V1 scope (§35) is locked — don't decide it prematurely; it's genuinely a new service boundary either way, unlike the AI Opportunity Scanner which fit cleanly inside `e3d-applied`.

---

## 27. AWS / Mac Mini Boundary

Same pattern as the AI Opportunity Scanner spec: AWS owns customer/checkout/job-state/report-state/telemetry; the Mac Mini (or a proper cloud worker, once this leaves validation stage) may execute the actual analysis; never expose Mac Mini ports to public inbound traffic; use an outbound-poll pattern if the Mac Mini is used at all for real customer traffic. Given the security surface here (§13), there's a stronger case than the AI Opportunity Scanner had for running the analysis worker in an isolated cloud sandbox rather than on Chris's own development machine at all — worth deciding explicitly before V1, not defaulting to "runs wherever's convenient."

---

## 28-29. Failure Handling / Scan Lifecycle

Same shape as the AI Opportunity Scanner's proposed lifecycle (§29 of that spec), with two Codebase-Scan-specific additions: `awaiting_repository` needs a real "repo access failed/revoked/deleted mid-scan" path (not applicable to the other product), and `unsupported` needs to cover "repo too large" / "unsupported language mix" as first-class outcomes, not generic failures — a customer should get a clear, honest "we can't scan this yet" rather than a silent failure or a low-quality forced report.

---

## 30-31. Telemetry / Product Feedback

Same event-shape approach as the AI Opportunity Scanner (§34/§41 there) — same principle of never sending source code into analytics, extended here to also mean never sending file paths/contents/citations into general telemetry, only aggregate signals (repo size bucket, language mix, opportunity category mix, scan duration, generation cost).

---

## 32. Business Success Criteria

Falsifiable questions, technical-customer-specific: will a technical stranger pay sight-unseen for a code-grounded report (same underlying bet as the AI Opportunity Scanner's "will a business pay for an AI-opportunity report," worth noting these are testing adjacent hypotheses); do they actually complete repo authorization (a new drop-off point that doesn't exist for the other product); are recommendations genuinely source-grounded and non-obvious to someone who already knows their own codebase (a much higher bar than the AI Opportunity Scanner's "non-obvious to a business owner," since the customer here is a domain expert on their own code); do they buy a Build Spec afterward (the real test of the product-ladder thesis).

---

## 33. Anything Surprising

The scoring-fanout mechanism (`lib/scoring/fanout.sh`) is better-engineered and more directly reusable than discover or ideate themselves — a "reasoning happens in parallel across distinct roles, code owns the final number" pattern worth carrying into *both* scanner products regardless of what else gets rebuilt. The negotiate/execute/review half of `e3d-pilot` is meaningfully more production-ready than discover/ideate — the "e3d-pilot is nearly a product" intuition was picking up on the wrong half of the pipeline. And: `draft` already writes specs in exactly the phased-CSR format this whole session has been using by hand for `e3d-corp`/`e3d-trade` and the AI Opportunity Scanner — there's a real, near-term, low-risk win in having `e3d-pilot`'s own `draft` stage generate implementation tickets like these automatically, independent of whether either scanner product ever ships.

---

## 34. Implementation Phases (if this proceeds)

```text
Phase 0   Source-of-truth verification (this document already did the code-level half;
          still needed: confirm AWS/e3d-applied specifics at actual build time, since
          that repo changes independently of this spec)
Phase 1   Product shell: landing page, checkout (reusing whatever the AI Opportunity
          Scanner's commerce build already established, not rebuilt from scratch)
Phase 2   Repository acquisition (public-URL clone or archive upload; explicitly no
          GitHub App/OAuth in V1)
Phase 3   Untrusted-content filtering and safety limits (§13) — build before Phase 4,
          not after
Phase 4   New source-reading + evidence-extraction pass (the real "discover" for this
          product — net-new, not e3d-pilot's discover)
Phase 5   New candidate-generation + scoring (reusing the fanout pattern, new dimensions)
Phase 6   Report generation and delivery
Phase 7   Telemetry, feedback, Build-Spec upsell plumbing into e3d-pilot's draft stage
Phase 8   Security/failure-recovery hardening
Phase 9   Production launch
```

Do not start Phase 1 until the build-order question in §37 below is actually decided.

---

## 35. V1 Non-Goals

Same list as the original spec (§35), all of it still correct given the findings above — if anything, more of it is now clearly correct to defer, since GitHub App/OAuth (already listed as excluded from "repository access" complexity by recommending public-URL/archive-only for V1) and any form of code execution are now confirmed to require from-scratch infrastructure, reinforcing why they shouldn't be V1 scope.

---

## 36. Reusable vs. Product-Specific (summary)

**Reusable, build once**: customer/checkout/entitlement, job lifecycle pattern, report hosting/auth, telemetry pipeline, feedback collection, upsell-CTA-separate-from-scoring discipline, the scoring-fanout mechanism as an approach.

**Product-specific to Codebase Scan**: everything in §10-13 (source-reading, evidence extraction, repo access, untrusted-content security) — none of it transfers to or from the AI Opportunity Scanner.

---

## 37. Build Order Recommendation

**Do not build the Codebase Opportunity Scan before the AI Opportunity Scanner.** Reasoning, not just deference to the other spec being first:

- The premise that made this look like a fast follow — "`e3d-pilot` already did the hard part" — is largely false. The half of the pipeline that would run for every paying customer (discover+ideate) needs to be substantially rebuilt, not lightly adapted. The genuinely reusable piece (draft/negotiate/execute/review) is a *later*-stage upsell, not the core product.
- This product's security surface (executing analysis against a stranger's arbitrary, potentially hostile source code) is categorically larger and more novel than the AI Opportunity Scanner's (free-text business answers only). That's real engineering risk and time, not just more spec pages.
- FutCo is already mid-motion on the AI Opportunity Scanner, having just decided on a no-code manual-concierge V0 to test the commercial hypothesis cheaply. That V0 tests a hypothesis this product substantially shares — will a stranger pay for an automated-plus-human-reviewed opportunity report — at near-zero cost. Let that result inform whether *either* scanner is worth the harder engineering investment before committing to this one specifically.
- Shared first phase, if both proceed eventually: the commerce/checkout/entitlement/telemetry shell (§36). Build it once, generically, in whichever product goes first — don't build it twice.

**If Chris wants to de-risk this product's specific, distinct hypothesis (source-grounded recommendations, technical-buyer willingness to pay) before committing to the full build**: the same manual-concierge move applies here too, arguably even more usefully than for the AI Opportunity Scanner — Chris (or Claude, supervised) manually clones or reviews a willing customer's public repo, writes the report by hand, no product code at all. That tests the hardest, most specific part of this product's thesis (can source-grounded analysis actually surface something a technical founder finds non-obvious) without building any of the security or repository-access infrastructure this spec identified as the real cost.

---

## 38. Go/No-Go

**No-go for immediate build.** Go for a manual-concierge test of the specific hypothesis, at Chris's discretion, using the same reasoning already applied to the AI Opportunity Scanner. Revisit full automated build only after (a) the AI Opportunity Scanner's V0 validates the shared commercial bet, or (b) a manual codebase-scan test independently validates that source-grounded recommendations are genuinely differentiated and valuable to a technical buyer.
