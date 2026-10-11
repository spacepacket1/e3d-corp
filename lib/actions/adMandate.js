import { appendEvent, queryEvents } from '../events/store.js';
import { assertProposalAuthorized } from '../authority/policy.js';
import {
  AD_MANDATE_PROPOSAL_TYPE,
  validateAdMandatePayload,
  validateAdMandateTransition,
  validateAdMandateConstraintsAgainstPolicy
} from '../proposals/adMandateSchema.js';

function existingActivationEvent(dataDir, mandateId) {
  const events = queryEvents(dataDir, { type: 'ad-mandate.activated' });
  return events.find((event) => event.payload?.mandateId === mandateId) ?? null;
}

function validateApprovedMandate(mandate, proposalId) {
  const { valid, errors } = validateAdMandatePayload(mandate);
  if (!valid) {
    throw new Error(`Action refused: invalid ad_mandate payload\n- ${errors.join('\n- ')}`);
  }
  if (mandate.status !== 'approved') {
    throw new Error(`Action refused: ad_mandate ${mandate.mandate_id} must be approved before activation (status: ${mandate.status})`);
  }
  if (mandate.proposal_id !== proposalId) {
    throw new Error(`Action refused: ad_mandate proposal_id ${mandate.proposal_id} does not match proposal ${proposalId}`);
  }
  if (!mandate.decision_id) {
    throw new Error(`Action refused: ad_mandate ${mandate.mandate_id} has no approving decision_id`);
  }
}

// Unlike submitCapitalMandate, there is no separate execution service to hand
// this off to - e3d-corp both proposes and later consults this mandate
// itself (autoDecideUnderMandate, docs/futco-ad-mandate-spec.md Phase 2), so
// activation is purely an internal state transition plus the hard-ceiling
// check against instanceConfig.adRiskPolicy. Fails closed if that policy
// isn't configured, rather than activating a mandate against no real ceiling.
export async function activateAdMandate(proposal, ctx = {}) {
  assertProposalAuthorized(proposal, AD_MANDATE_PROPOSAL_TYPE);

  const { dataDir, causationId = null, correlationId, instanceConfig } = ctx;
  if (!dataDir) {
    throw new Error('activateAdMandate requires a dataDir');
  }

  const mandate = proposal.payload;
  const mandateId = typeof mandate?.mandate_id === 'string' ? mandate.mandate_id : null;
  const priorEvent = mandateId ? existingActivationEvent(dataDir, mandateId) : null;
  if (priorEvent) {
    return { activated: false, idempotent: true, mandateId, event: priorEvent };
  }

  validateApprovedMandate(mandate, proposal.id);

  const policyCheck = validateAdMandateConstraintsAgainstPolicy(mandate.constraints, instanceConfig?.adRiskPolicy);
  if (!policyCheck.valid) {
    throw new Error(`Action refused: ad_mandate ${mandate.mandate_id} failed the hard-ceiling check\n- ${policyCheck.errors.join('\n- ')}`);
  }

  const activatedAt = new Date().toISOString();
  const transition = validateAdMandateTransition(mandate.status, 'active');
  if (!transition.valid) {
    throw new Error(`Action refused: ${transition.errors.join('; ')}`);
  }

  const append = ctx.appendEvent ?? ((event) => appendEvent(dataDir, event));
  const event = append({
    type: 'ad-mandate.activated',
    source: 'action:ad_mandate',
    subject: { type: 'proposal', id: proposal.id },
    payload: {
      proposalId: proposal.id,
      mandateId: mandate.mandate_id,
      owner: mandate.owner,
      allowedProducts: mandate.constraints?.allowed_products ?? [],
      maxDailySpendUsd: mandate.constraints?.max_daily_spend_usd ?? null,
      maxMonthlySpendUsd: mandate.constraints?.max_monthly_spend_usd ?? null,
      previousStatus: mandate.status,
      activatedStatus: 'active',
      activatedAt
    },
    causationId,
    correlationId: correlationId ?? proposal.correlationId
  });

  return { activated: true, idempotent: false, mandateId: mandate.mandate_id, event };
}
