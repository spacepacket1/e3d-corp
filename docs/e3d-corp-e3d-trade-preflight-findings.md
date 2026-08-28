# e3d-corp / e3d-trade Preflight Findings

Phase: 1 - Preflight and Verification

Date: 2026-08-27

Headline: GO for Phases 2-8. No material false assumption was found that blocks the plan. Several foundation claims need correction or tightening before later phases rely on them.

## Scope Read

- `e3d-corp`: event log, opportunity/proposal/decision/action/outcome/experience, authority policy, web/CLI registration paths, package scripts.
- `e3d-trade`: `pipeline.js`, `server.js`, `e3dAuthClient.js`, risk/evidence/audit/reconciliation scripts, `scripts/e3dActionOutcomeExport.js`, `scripts/portfolioSnapshotWriter.js`, package scripts.
- Not inspected: the separate `e3d` / `spacepacket` repo, because it is not present in the provided workspace roots.

## Existing Foundations - e3d / spacepacket

| Claim | Status | Finding |
|---|---|---|
| E3D provides Stories, Theses, Token Intelligence, and Transactions as first-class objects. | not-found | The separate E3D repo is not in this workspace, so this cannot be directly verified here. `e3d-trade` does call E3D story/thesis/token endpoints, which supports the integration assumption from the trade side. |
| Both `e3d-corp` and `e3d-trade` already talk to E3D independently. | needs-correction | `e3d-trade` has a session/API-key authenticated `e3dAuthClient.js` and many E3D API calls. `e3d-corp` currently has an `e3d-applied` lead/contact event source, but no direct Stories/Theses client found. Phase 2 should add the investing-specific E3D read path in `e3d-corp`; it should not assume one exists. |

## Existing Foundations - e3d-trade

| Claim | Status | Finding |
|---|---|---|
| Live agentic trading pipeline exists, not a placeholder. | confirmed | `pipeline.js` implements a full paper trading cycle with portfolio load/save, Scout, Harvest, Risk, Executor, Manager, logs, training events, and paper portfolio mutation. |
| Five agents: Scout, Harvest, Risk, Executor, Manager. | confirmed | Scout and Harvest prompts/functions produce structured candidates/reviews; Risk validates and gates; Executor validates final paper/live decision shape; Manager records post-cycle reports inline via `runManagerDirect`. |
| Continuous cycle default every 5 minutes. | needs-correction | Current code defaults to a 6-hour swing-desk cadence (`DEFAULT_PIPELINE_INTERVAL_SECONDS = 6 * 60 * 60`) and dashboard start defaults to 21600 seconds. Some older docs and cron scripts still mention 5 minutes. |
| "AI suggests, code decides." | confirmed | Agents return JSON; deterministic code validates Scout/Harvest payloads, applies buy/exit gates, performs risk checks, sizes positions, and mutates the paper portfolio. |
| Story-anchored discovery: zero story activity excludes a token regardless of volume/price. | confirmed | Scout universe construction filters candidates to price-API story activity or direct story API mention. Flow-only entry is currently disabled in the Scout prompt. |
| Pulls Stories, candidates, theses, and token prices from E3D via session-authenticated client. | confirmed | `e3dAuthClient.js` supports API-key and login-session auth; `pipeline.js` uses E3D stories, candidates, theses, token prices, and authenticated curl args. |
| Paper-trades by default; `live_execution_allowed` is code-level, not prompt-only. | confirmed | Portfolio settings default `paper_mode: true`; pipeline risk/executor prefer paper decisions; risk engine and audit/custody paths set `live_submission_enabled: false` and block live-capable modes. |
| Existing risk engine exists. | confirmed | `scripts/riskEngine.js` exposes deterministic policy resolution and `evaluateRiskDecision`, with hard limits for drawdown/losses, exposures, positions, turnover, liquidity, spread/slippage, risk-off regimes, cooldowns, and live-capability blocks. |
| Risk engine can cleanly accept an external constraint layer. | confirmed | The plan is viable, but should be implemented carefully: `evaluateRiskDecision` accepts policy input, while raw overrides are treated as risk overrides and may be blocked. Phase 5 should layer mandate constraints as a stricter pre-policy/checked-limit adapter, never as an arbitrary loosening override. |
| Evidence packets exist. | confirmed | `scripts/evidencePackets.js` builds Scout/Harvest packets, evidence IDs, refs, quality metadata, and ranking inputs. Pipeline records evidence packet IDs/refs onto risk and trade metadata. |
| Promotion gates exist. | confirmed | `scripts/promotionGates.js` and verification scripts are present and wired into `npm run check`. |
| Custody controls exist. | confirmed | `scripts/custodyControls.js` is imported by risk/audit/server code and participates in live-capability blocking. |
| Audit trail exists. | confirmed | `scripts/auditTrail.js` records operator actions, permission policies, mode-change/risk-override controls, and audit event IDs to JSONL. |
| Reconciliation exists. | confirmed | `scripts/reconciliationAccounting.js` reconstructs paper trades, compares replay/accounting state, and is included in package verification with `--no-write`. |
| `server.js` is dashboard/API + WebSocket surface and a natural mandate-intake location. | confirmed | `server.js` exposes HTTP API routes, static dashboard assets, `/ws` WebSocket updates, E3D auth routes, pipeline controls, portfolio/activity/report endpoints, and dashboard health/status surfaces. |
| No external governing mandate currently exists. | confirmed | No mandate model, mandate endpoint, mandate status check, or mandate-aware Scout/Risk metadata was found. This is the main gap for later phases. |

## e3d-trade Phase 6 Adjacent Scripts

| Script | Status | What it does | Reuse recommendation |
|---|---|---|---|
| `scripts/e3dActionOutcomeExport.js` | confirmed reusable | Reads local training events from JSONL or ClickHouse, selects `executor_decision`, `trade`, and `outcome` events, maps them to `E3DAgentActions` / `E3DAgentOutcomes`, supports dry-run, state/watermark, lock files, ClickHouse DDL, inserts, and cron installation. | Reuse/extend for Phase 6 mapping, IDs, watermarks, locking, and ClickHouse export logic. It does not currently post results to `e3d-corp` or carry mandate IDs/correlation IDs from a capital mandate. |
| `scripts/portfolioSnapshotWriter.js` | confirmed reusable | Writes one `AgentPortfolioSnapshots` ClickHouse row per invocation from `portfolio.json`, including equity, cash, PnL, open positions, cooldown count, and ETH/BTC benchmark values. | Reuse for experiment metrics and benchmark snapshots. It is portfolio-level telemetry, not an Action/Outcome delivery mechanism by itself. |

## Existing Foundations - e3d-corp

| Claim | Status | Finding |
|---|---|---|
| General-purpose company-agnostic runtime exists. | confirmed | Runtime is not investing-specific; current README and code center on evidence-backed opportunities, proposals, approvals, actions, outcomes, and experience. |
| Seven durable primitives exist: Event -> Opportunity -> Proposal -> Decision -> Action -> Outcome -> Experience. | confirmed | Corresponding libraries exist under `lib/events`, `lib/opportunities`, `lib/proposals`, `lib/decisions`, `lib/actions`, `lib/outcomes`, and `lib/experience`. |
| State transitions are append-only events. | confirmed | Events are appended to `events.jsonl`; opportunities, proposals, actions, outcomes, and experience are folded from logs or append-only snapshots. |
| Event log is hash-chained and tamper-evident with external anchoring. | confirmed | `lib/events/store.js` writes `prevHash`/`hash`; `lib/anchor/anchor.js` computes chain heads, records anchors, verifies in-log and external anchors. |
| Models never mutate state directly. | confirmed | Role output is validated, then deterministic engines append events. Opportunity role output passes through `validateOpportunityCandidate` before becoming an Opportunity. |
| Consequential actions are gated behind explicit human Decision enforced inside action functions. | confirmed | `assertProposalAuthorized` fails closed and is called by action executors such as `sendOutreach` and `pilotHandoff`; `decideProposal` and `confirmAndExecute` enforce approval and authority levels. |
| Decision ledger and causal traceability exist via `causationId` / `correlationId`. | confirmed | Events require `correlationId`; non-null causation IDs must reference existing events; `reconstructChain` and `assembleExperience` use correlation IDs to rebuild chains. |
| Outcome/Experience calibration primitives exist. | confirmed | Outcomes are recorded as event types and trigger `assembleExperience` + append-only experience snapshots. |
| Currently instantiated for prospect-quality filtering / business development, not investing. | confirmed | Opportunity types, roles, event sources, proposals, outcomes, and README examples are business-development oriented. No investing Opportunity or `capital_mandate` type exists yet. |
| Human approval gating fits a cross-service call. | confirmed | Cross-service handoff is already represented by `pilot-handoff` as an approved action. A mandate submission action can follow the same registry/policy pattern, likely as a financial authority action if it delegates capital authority. |

## Integration Convention

| Claim | Status | Finding |
|---|---|---|
| Repos should integrate over APIs/shared services, not source imports. | confirmed | `e3d-trade` already runs an independent API/dashboard service, and `e3d-corp` already has action executors that can perform external side effects after approval. No direct import is needed for later phases. |

## Go / No-Go

Recommendation: GO for Phases 2-8.

Conditions for later phases:

- Phase 2 must add or reuse an explicit `e3d-corp` E3D Stories/Theses read path; do not assume one already exists.
- Phase 5 must preserve the no-active-mandate baseline exactly and add mandate constraints strictly as a narrowing layer over existing deterministic risk gates.
- Phase 5 should not use raw `input.policy` as a mandate escape hatch unless it proves loosening is impossible; a mandate-specific stricter adapter is safer.
- Phase 6 should extend `e3dActionOutcomeExport.js` / snapshot telemetry rather than rebuilding export, but still needs a real `e3d-corp` outcome delivery path keyed by `mandate_id` and `correlation_id`.
- Acceptance tests should account for the current 6-hour default cadence, not the stale 5-minute claim.
