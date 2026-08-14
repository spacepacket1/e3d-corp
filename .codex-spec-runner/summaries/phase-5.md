# Phase 5 Summary

- Phase: 5
- Title: Proposal, Authority Policy, and Decision Framework
- Provider: claude
- Model: sonnet
- Completed: 2026-08-14T06:55:32-0700
- Exit status: 0

## Implementation Handoff

- `lib/authority/policy.js`: `AUTHORITY_LEVELS` (0-4) enum + descriptions, versioned `ACTION_POLICY` table (`send-outreach`:2, `pilot-handoff`:2, `issue-invoice`:3, `mark-deal-closed`:4 — only levels 2-4 appear, since 0-1 never get a Proposal). `getRequiredAuthorityLevel(type)` fails closed for unknown types. `assertProposalAuthorized(proposal, actionType)` is the guard every action-execution function (Phase 7+) must call as its own first line: checks type match, authorityLevel match against the table, and `status === 'approved'`, with no override.
- `lib/authority/notify.js`: `authorityNotify(instanceConfig, proposal)` — best-effort `spawn` of `authorityNotify.command` (shell, detached, unref'd, `error` event swallowed); returns a result object and never throws. No email transport exists in this repo, so `authorityNotify.email` is passed to the command as an env var, not sent directly.
- `lib/actions/registry.js`: in-process `Map` (`registerActionExecutor`/`getActionExecutor`/`clearActionExecutor`/`listRegisteredActionTypes`) letting `decide.js` invoke a Phase-7+ action function by proposal `type` without importing it directly.
- `lib/proposals/schema.js` + `lib/proposals/store.js` + `lib/proposals/create.js`: Proposal schema `{ id, type, payload, proposedBy:{role,provider,model}, authorityLevel, causationId, correlationId, status, createdAt }`, folded from `proposal.created`/`.approved`/`.rejected` events (same event-log-as-source-of-truth pattern as Opportunities). `createProposal` **derives `authorityLevel` from the policy table itself**, never trusts a caller-supplied value — a deliberate decision so a role can never under-declare the authority an action needs; rejects types below level 2 (no proposal for autonomous actions) and unknown types.
- `lib/decisions/decide.js`: `decideOpportunity` (decision ∈ `reviewed|pursuing|no-value`, appends `opportunity.reviewed` with `payload.status` mirroring `decision` so Phase 4's store fold picks it up unchanged) and `decideProposal` (decision ∈ `approved|rejected`, appends `proposal.approved`/`.rejected`; refuses a non-`pending` proposal). For an approved level-2 proposal, `decideProposal` looks up the registry and executes in the same call if a executor is registered (`executed`/`executionResult` on the return value) — this is the literal "approval and execution are the same call." For level-3/4, approval only flips status. `confirmAndExecute(dataDir, proposalId, confirmedBy, via)` is the separate step: requires `status === 'approved'` and `authorityLevel >= 3`, refuses level-2 (already executed on approval).
- CLI (`lib/cli.js`): added `opportunities decide <id> --status --reason [--decided-by]`, `proposals approve|reject <id> --reason [--decided-by]`, plus `proposals list`/`proposals show` (dev/debug parity with Phase 4's opportunities list/show, not spec-required but low-risk and directly useful for scripting ahead of Phase 6). All are thin wrappers calling `decide.js` — no decision logic in the CLI. Updated help text/dispatcher; no change needed to `bin/e3d-corp` or the `test/phase1.test.js` help-text assertion (prefix unchanged).
- No instance-config schema changes were needed — `authorityNotify` was already defined in Phase 1.
- Tests: `test/phase5.test.js` covers — policy table lookups/fail-closed; `assertProposalAuthorized` refusing a pending proposal when called directly (the specified "bypass CLI/UI" acceptance test) plus type/level mismatches; `createProposal`'s derived-authorityLevel and malformed-input rejection with no partial write; `decideOpportunity` validation and event/causation correctness; level-2 approve-and-execute-in-one-call plus double-decision refusal; level-3/4 approve-then-separate-`confirmAndExecute`, including refusing `confirmAndExecute` pre-approval and refusing it for level-2; rejection never executes; a full `lead.received → opportunity.created → .scored → .reviewed → proposal.created → proposal.approved` chain reconstructed via `reconstructChain(correlationId)` with `via` verified at each decision event; `authorityNotify` best-effort behavior (no config, and a failing command) never blocking `createProposal`; CLI-level approve/reject across all three levels and `opportunities decide` including its own missing-flag error path.

## Verification
- passed: `npm test`

## Worktree Snapshot
- ` M .codex-spec-runner/manifest.tsv`
- ` M lib/cli.js`
- `?? .codex-spec-runner/summaries/phase-5.md`
- `?? lib/actions/`
- `?? lib/authority/`
- `?? lib/decisions/`
- `?? lib/proposals/`
- `?? test/phase5.test.js`
