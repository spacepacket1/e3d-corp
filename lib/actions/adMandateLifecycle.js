import { appendEventWithinLock, withEventsLockAsync } from '../events/store.js';
import { getProposal } from '../proposals/store.js';
import { AD_MANDATE_PROPOSAL_TYPE, currentAdMandateStatus, validateAdMandateTransition } from '../proposals/adMandateSchema.js';

const KILL_SWITCH_STATUSES = new Set(['revoked', 'suspended']);

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
}

// docs/futco-ad-mandate-spec.md section 6 ("Kill switch"): no new lifecycle
// state is needed - revoked/suspended already exist on ad_mandate - only a
// reachable way to trigger one. This is the single implementation both a
// human (CLI `proposals suspend-mandate`/`revoke-mandate`, the web UI) and
// the automated circuit breaker (ops/reports/checkAdMandateHealth.js, via
// eventType "ad-mandate.auto-suspended" so the event log always shows which
// transitions were a human and which were automatic) call. Re-derives the
// mandate's *live* status before transitioning, inside the same event-log
// lock autoDecideUnderMandate uses, so two concurrent kill-switch calls (or
// a kill-switch racing an autonomous decision) can never double-apply or act
// on a stale read - exactly the discipline the spec asks for ("revoking
// mid-cycle must stop autonomous decisions on the next check").
export async function transitionAdMandateLifecycle(dataDir, {
  mandateProposalId,
  toStatus,
  eventType,
  reason,
  decidedBy,
  via,
  correlationId: correlationIdOverride
} = {}) {
  if (!KILL_SWITCH_STATUSES.has(toStatus)) {
    throw new Error(`transitionAdMandateLifecycle: toStatus must be one of ${[...KILL_SWITCH_STATUSES].join(', ')}, got "${toStatus}"`);
  }
  requireNonEmptyString(mandateProposalId, 'mandateProposalId');
  requireNonEmptyString(reason, 'reason');
  requireNonEmptyString(decidedBy, 'decidedBy');
  requireNonEmptyString(via, 'via');
  if (!dataDir) {
    throw new Error('transitionAdMandateLifecycle requires a dataDir');
  }
  const resolvedEventType = typeof eventType === 'string' && eventType.trim() !== '' ? eventType.trim() : `ad-mandate.${toStatus}`;

  let result = null;

  await withEventsLockAsync(dataDir, async () => {
    const mandateProposal = getProposal(dataDir, mandateProposalId);
    if (!mandateProposal || mandateProposal.type !== AD_MANDATE_PROPOSAL_TYPE) {
      throw new Error(`Action refused: ${mandateProposalId} is not a known ad_mandate proposal`);
    }
    const mandate = mandateProposal.payload;
    const liveStatus = currentAdMandateStatus(mandate);
    const transition = validateAdMandateTransition(liveStatus, toStatus);
    if (!transition.valid) {
      throw new Error(`Action refused: cannot transition ad_mandate ${mandate.mandate_id}: ${transition.errors.join('; ')}`);
    }

    const transitionedAt = new Date().toISOString();
    const event = appendEventWithinLock(dataDir, {
      type: resolvedEventType,
      source: `decision:${via}`,
      subject: { type: 'proposal', id: mandateProposalId },
      payload: {
        proposalId: mandateProposalId,
        mandateId: mandate.mandate_id,
        previousStatus: liveStatus,
        toStatus,
        reason,
        decidedBy,
        via,
        transitionedAt
      },
      causationId: null,
      correlationId: correlationIdOverride ?? mandateProposal.correlationId
    });

    result = { transitioned: true, mandateId: mandate.mandate_id, previousStatus: liveStatus, toStatus, event };
  });

  return result;
}
