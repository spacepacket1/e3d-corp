import { queryEvents } from '../events/store.js';
import { createProposal } from './create.js';

function latestEventForOpportunity(dataDir, opportunityId) {
  const events = queryEvents(dataDir, { subject: { type: 'opportunity', id: opportunityId } });
  return events[events.length - 1] ?? null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Same shape as proposePilotHandoff - a structured, deterministic proposal
// creator, not an LLM-drafted one - but targets e3d-creative directly instead
// of handing an opportunity to e3d-pilot for engineering. This is the "CAST
// can already produce a distinct variant, skip Pilot entirely" path the
// manifesto describes (docs/futco-ad-outcome-loop-manifesto.md in e3d-pilot,
// section 2 step 4): no new engineering capability is needed, just a new
// creative direction for an existing product/campaign.
export function proposeCommissionCreative(
  dataDir,
  { opportunity, brief, reason, proposedBy, instanceConfig, sourceBriefEventId = null } = {}
) {
  if (!opportunity || !opportunity.id || !opportunity.correlationId) {
    throw new Error('proposeCommissionCreative requires an opportunity with an id and correlationId');
  }
  if (opportunity.status !== 'pursuing') {
    throw new Error(
      `Opportunity ${opportunity.id} is not "pursuing" (status: ${opportunity.status}); refusing to propose a creative commission`
    );
  }
  if (!isPlainObject(brief)) {
    throw new Error('proposeCommissionCreative requires a brief object (e3d-creative\'s brief input shape)');
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error('proposeCommissionCreative requires a non-empty reason');
  }
  if (sourceBriefEventId !== null && (typeof sourceBriefEventId !== 'string' || sourceBriefEventId.trim() === '')) {
    throw new Error('proposeCommissionCreative requires sourceBriefEventId to be null or a non-empty string');
  }

  const causationEvent = latestEventForOpportunity(dataDir, opportunity.id);

  return createProposal(dataDir, {
    type: 'commission-creative',
    payload: {
      opportunityId: opportunity.id,
      opportunityTitle: opportunity.title,
      brief,
      reason: reason.trim(),
      // Set when this proposal was auto-generated from a creative.brief
      // role's drafted brief (lib/proposals/autoProposeFromBrief.js) - the
      // idempotency key that scan uses to avoid proposing the same drafted
      // brief twice. null for a manually-authored commission (the pre-brief
      // path this field was added alongside).
      sourceBriefEventId
    },
    proposedBy: proposedBy ?? { role: 'operator', provider: 'human', model: 'n/a' },
    causationId: causationEvent ? causationEvent.id : null,
    correlationId: opportunity.correlationId,
    instanceConfig
  });
}
