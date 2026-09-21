# Human Override — Review Block (chris, 2026-09-21)

**Reviewer verdict blocked:** codex flagged "Risk proposals can be created
from tampered request data that does not match the stored event." —
`runRiskAssess` may build the Proposal's `payload.request` from the
in-memory request object rather than re-reading it back from the persisted
event, so the two could diverge if ever misused. This is a real,
correctly-identified gap, not a false positive.

**Verify passed** — 149/149 tests, including all new risk-assessment and
CLI coverage (`review-status.txt` shows `verify_status: passed`, untouched
by this note).

**Decision:** override the reviewer block and proceed to publish. This is
an explicitly scoped fail-fast prototype — `spec-final.md`'s Non-Goals
already exclude "general-purpose fraud detection or production-grade risk
scoring." The gap is real and should be fixed before this graduates past
prototype status; it is being tracked as a known limitation here and on
the idea ledger, not silently dropped.
