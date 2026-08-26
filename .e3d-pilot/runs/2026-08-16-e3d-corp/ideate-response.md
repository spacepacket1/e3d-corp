### Candidate 1: CLI `--json` output + `--dry-run` flags
Duplicate: no
Dedup rationale: Only branch is `main` (69fa3ba); no PRs, no issues, no prior runs. No existing work on machine-readable output.
Category: workflow
Analogy: Developer-tool CLI ergonomics (`gh`, `fly`, `cargo`) -- `--json` on list/show enables piping into scripts; `--dry-run` on approve/confirm lets operators build safe overnight automation while the structural authority gate still runs. Exactly the `gh pr merge --auto` pattern.
Attraction (1-5): 4
Retention (1-5): 4
Effort: low
Revenue (1-5|n/a): 3
Description: Add `--json` output flag to `opportunities list`, `opportunities show`, `proposals list`, `proposals show`, and `evaluate report`. Add `--dry-run` to `proposals approve` and `proposals confirm` (prints the action that would fire, exits 0). This completes the "one interface for humans and scripts" property already implicit in the CLI's subcommand structure, removes the need for a separate API surface, and makes the tool composable with cron/PM2 pipelines operators already run.

---

### Candidate 2: Pipeline velocity + aging indicators in web UI
Duplicate: no
Dedup rationale: Only branch is `main`; no PRs or prior runs. Evaluation layer tracks latency but the web UI renders it nowhere.
Category: workflow
Analogy: Game progression and reward loops (Habitica, Duolingo streaks) -- the `candidate → scored → reviewed → pursuing → won/lost` state machine is structurally a quest chain; surfacing average cycle time per stage and decay warnings for stale `pursuing` opportunities borrows urgency/momentum mechanics without gamification clutter.
Attraction (1-5): 3
Retention (1-5): 5
Effort: medium
Revenue (1-5|n/a): 2
Description: Add a "Pipeline health" panel to `/metrics` and a per-row age badge on `/opportunities`. Show: average days in each status, a warning highlight when a `pursuing` opportunity has had no proposal for >N days (configurable, default 7), and funnel drop-off rates pulled from existing `evaluate report` data. All inputs are already in the event store; this is a read-only rendering change that gives operators a daily reason to open the UI.

---

### Candidate 3: Demo/sandbox mode with synthetic data
Duplicate: no
Dedup rationale: Only branch is `main`; no PRs or prior runs. README explicitly states "no demo data safe to serve unauthenticated."
Category: marketing
Analogy: SaaS trial UX (Figma, Linear sandbox orgs) -- pre-loaded synthetic company + opportunities + proposals + outcomes let evaluators tour the full decision loop without credentials or an LLM endpoint.
Attraction (1-5): 5
Retention (1-5): 2
Effort: medium
Revenue (1-5|n/a): 2
Description: Add `--sandbox` flag to `node bin/e3d-corp web`. Starts with a bundled read-only synthetic `events.jsonl` (fake company "Acme Consulting", 20 opportunities across several types, 3 proposals at various states, 2 outcomes, 1 won deal). All mutating routes return `403 Sandbox — read-only` with a banner explaining how to configure a real instance. Removes the single biggest evaluation barrier (requires a real instance + LLM + credentials before seeing anything).

---

### Candidate 4: External hash anchor workflow
Duplicate: no
Dedup rationale: Only branch is `main`; no PRs or prior runs. README explicitly flags this gap: "Detection of *partial* edits is the guarantee; a full rewrite needs an external copy to catch."
Category: other
Analogy: Certificate Transparency / fintech audit logs -- publishing the latest chain hash to an external, operator-independent location (signed git commit tag, RFC 3161 timestamping service, or a public paste) closes the full-rewrite detection gap for the same 32 bytes the Merkle-append pattern uses.
Attraction (1-5): 2
Retention (1-5): 3
Effort: low
Revenue (1-5|n/a): 1
Description: Add `event anchor` command: reads the current chain tip hash, writes it to a configurable external sink (initially: `git tag --sign e3d-anchor-<timestamp>` in the instance repo, or POST to a configurable webhook URL). Add `event verify --anchor` to compare the live chain tip against the most recent anchor. Closes the explicitly-documented limitation with minimal infrastructure; the primitives already exist in `lib/store/appendOnlyLog.js`.

---

---IDEATE-STATUS---
selected: candidate-1
reason: Highest A+R sum (8) with revenue tiebreak over candidate-2; low effort, no new dependencies, directly enables the cron/PM2 automation operators already run.
