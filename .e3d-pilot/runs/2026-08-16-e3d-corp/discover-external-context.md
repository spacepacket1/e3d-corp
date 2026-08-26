## External Context

- **Agentic automation maturity**: The field has shifted from single-model chat to multi-step agent pipelines (LangGraph, Prefect AI, AutoGen). The differentiating design tension now is *authority boundary placement* — most frameworks still leave this as user convention rather than enforcement.
- **Event-sourced AI systems**: Append-only event logs as the single source of truth (following CQRS/ES patterns) are gaining traction in production AI systems as the only auditable alternative to mutable agent state. NATS JetStream and Kafka are common infrastructure choices at scale; e3d-corp's flat JSONL is the appropriate analog at small-company scale.
- **Human-in-the-loop (HITL) tooling**: Products like Humanloop, Scale RLHF, and LangSmith all instrument model outputs for review, but none enforce a policy-table-derived authority level before execution — approval is advisory, not structural.
- **Retrieval-grounded evidence**: RAG over company knowledge bases (via MCP, direct vector search) is now baseline expectation; the differentiator is *citation traceability* — tying every claim to a specific retrieved artifact rather than a blended embedding, which e3d-corp does with `evidence.gathered` events.
- **Signal-to-CRM pipelines**: Tools like Clay and Apollo combine signal ingestion with outreach sequencing, but skip the scoring/decision layer entirely; they are execution-first, evidence-optional.
- **Hash-chained audit logs**: Canonical in fintech (blockchain, Certificate Transparency logs, AWS CloudTrail integrity validation). Relatively rare in internal business-process tooling; the `prevHash` chain pattern here is directly analogous to Certificate Transparency's Merkle tree append model.

---

### Analogous Patterns

**1. Fintech trust and verification UX → applied to authority gates**
*Source domain*: Multi-party payment authorization (e.g., ACH same-day release, wire transfer dual-control).
*Mechanic borrowed*: Tiered approval thresholds where higher-value transactions require a separate, explicit second-factor step from a distinct session or actor — not just a checkbox on the same screen.
*Application*: The level 3/4 `proposals confirm` two-step maps exactly to dual-control wire release. The next evolution could expose *why* the threshold was crossed (policy diff shown at confirmation time) and support a second authorized principal performing the confirm step, rather than always the same operator — hardening the separation of concerns that fintech regulation already demands.

**2. Game progression and reward loops → applied to the opportunity pipeline**
*Source domain*: RPG quest and unlock systems (e.g., Habitica, Duolingo streak mechanics).
*Mechanic borrowed*: Visible stage progression with clear "unlock" conditions and streak/momentum indicators that make advancement feel earned and reversals feel meaningful rather than silent.
*Application*: The `candidate → scored → reviewed → pursuing → won/lost` state machine is structurally identical to a quest chain, but the web UI currently renders it as a static table. Surfacing a "pipeline velocity" indicator — average cycle time per stage, decay warnings when a `pursuing` opportunity ages without a proposal — would borrow the *urgency and momentum* mechanic without adding gamification clutter, and it would feed directly into the evaluation layer that already tracks latency.

**3. Developer-tool CLI ergonomics → applied to the operator workflow**
*Source domain*: Modern CLI tooling (e.g., `gh`, `cargo`, `fly`).
*Mechanic borrowed*: Progressive disclosure via subcommands, `--dry-run` flags, and machine-readable `--json` output modes that let humans and scripts share one interface without separate API surfaces.
*Application*: `opportunities decide` and `proposals approve` currently require full flags every call. Adopting a `--json` output flag on list/show commands and a `--dry-run` on approve/confirm would let operators pipe output into scripts (e.g., auto-approve all pending proposals below a score threshold overnight) while keeping the safety gate structural — the confirm step still runs, just non-interactively. This is the same pattern `gh pr merge --auto` uses.
